// @vitest-environment node
/**
 * The remote store's least privilege, proved against the real `schema.sql`
 * and `roles.sql` on PGlite: what each login role may and may not do, the
 * insert backstops (rate and live bridge), the expire-only rule for the app,
 * the ids-only wake-ups, and the Realtime policy on the wake topic.
 *
 * One store per file; each test uses its own project so the rolling-minute
 * count of one never reaches another.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestStore, TEST_BRIDGE_UID, withPsqlVariables, type StoreRole, type TestStore } from "./test-store";

let store: TestStore;

beforeAll(async () => {
  store = await createTestStore();
}, 30_000);

afterAll(async () => {
  await store.close();
});

beforeEach(async () => {
  await store.lease(45);
});

const insertCommand = (project: string, overrides: { kind?: string; body?: unknown; expiresIn?: string } = {}) =>
  store.as<{ id: string }>(
    "ralph_web",
    `insert into ralph.command (project, kind, body, expires_at)
     values ($1, $2, $3::jsonb, now() + $4::interval) returning id`,
    [project, overrides.kind ?? "control", JSON.stringify(overrides.body ?? { loop: "ralph", action: "pause" }), overrides.expiresIn ?? "5 minutes"],
  );

const commandRow = async (id: string) =>
  (await store.owner<{ state: string; why: string | null }>("select state, why from ralph.command where id = $1", [id]))[0];

describe("the store", () => {
  it("applies schema.sql, roles.sql and intake.sql to the harness", async () => {
    const tables = await store.owner<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'ralph' order by table_name",
    );
    expect(tables.map((row) => row.table_name)).toEqual(["bridge", "command", "intake_snapshot", "snapshot", "viewer"]);
  });

  it("keeps the bridge to one row", async () => {
    await expect(store.owner("insert into ralph.bridge (singleton) values (false)")).rejects.toThrow(/check/);
    await expect(store.owner("insert into ralph.bridge (instance) values ('second')")).rejects.toThrow(/duplicate key/);
  });

  it("substitutes psql variables as literals and refuses a missing one", () => {
    expect(withPsqlVariables("select :'a'::uuid, ':: x'", { a: "it's" })).toBe("select 'it''s'::uuid, ':: x'");
    expect(() => withPsqlVariables("select :'missing'", {})).toThrow(/missing is not set/);
  });
});

describe("the login roles", () => {
  it("log in, inherit nothing and own nothing", async () => {
    const roles = await store.owner<{ rolname: string; rolcanlogin: boolean; rolinherit: boolean; owned: number }>(
      `select rolname, rolcanlogin, rolinherit,
              (select count(*)::int from pg_class where relowner = r.oid)
              + (select count(*)::int from pg_proc where proowner = r.oid)
              + (select count(*)::int from pg_namespace where nspowner = r.oid) as owned
       from pg_roles r where rolname in ('ralph_web', 'ralph_bridge') order by rolname`,
    );
    expect(roles).toEqual([
      { rolname: "ralph_bridge", rolcanlogin: true, rolinherit: false, owned: 0 },
      { rolname: "ralph_web", rolcanlogin: true, rolinherit: false, owned: 0 },
    ]);
  });

  for (const role of ["ralph_web", "ralph_bridge"] as const) {
    it(`${role} cannot create, alter or truncate`, async () => {
      await expect(store.as(role, "create table ralph.extra (a int)")).rejects.toThrow(/permission denied/);
      await expect(store.as(role, "create table public.extra (a int)")).rejects.toThrow(/permission denied/);
      await expect(store.as(role, "create schema extra")).rejects.toThrow(/permission denied/);
      await expect(store.as(role, "alter table ralph.command add column extra int")).rejects.toThrow(/must be owner/);
      await expect(store.as(role, "truncate ralph.command")).rejects.toThrow(/permission denied/);
    });

    it(`${role} cannot execute ralph.wake() directly`, async () => {
      await expect(store.as(role, "select ralph.wake()")).rejects.toThrow(/permission denied for function wake/);
      const [row] = await store.owner<{ can: boolean }>("select has_function_privilege($1, 'ralph.wake()', 'execute') as can", [role]);
      expect(row?.can).toBe(false);
    });
  }
});

describe("as ralph_web", () => {
  it("reads snapshots and the bridge, and cannot write a snapshot", async () => {
    await store.owner("insert into ralph.snapshot (project, key, body, hash, version) values ('web-read', 'dashboard', '\\x00', 'h', 1)");
    expect(await store.as("ralph_web", "select key from ralph.snapshot where project = 'web-read'")).toEqual([{ key: "dashboard" }]);
    expect(await store.as("ralph_web", "select instance from ralph.bridge")).toEqual([{ instance: "test-bridge" }]);
    await expect(store.as("ralph_web", "update ralph.snapshot set hash = 'forged'")).rejects.toThrow(/permission denied/);
    await expect(store.as("ralph_web", "insert into ralph.snapshot (project, key) values ('web-read', 'x')")).rejects.toThrow(/permission denied/);
    await expect(store.as("ralph_web", "update ralph.bridge set lease_until = now() + interval '1 day'")).rejects.toThrow(/permission denied/);
  });

  it("inserts a queued command", async () => {
    const [row] = await insertCommand("web-insert");
    expect(await commandRow(row!.id)).toEqual({ state: "queued", why: null });
  });

  it("cannot set the columns the bridge owns on insert", async () => {
    await expect(
      store.as("ralph_web", "insert into ralph.command (project, kind, body, expires_at, state) values ('web-cols', 'control', '{}', now(), 'claimed')"),
    ).rejects.toThrow(/permission denied/);
  });

  it("is refused an unknown kind, a body over 4 KB and an expiry over 10 minutes out", async () => {
    await expect(insertCommand("web-checks", { kind: "shell" })).rejects.toThrow(/command_kind_check/);
    await expect(insertCommand("web-checks", { body: { pad: "x".repeat(4096) } })).rejects.toThrow(/command_body_check/);
    await expect(insertCommand("web-checks", { expiresIn: "10 minutes 1 second" })).rejects.toThrow(/command_check/);
    await insertCommand("web-checks", { kind: "mark-read", expiresIn: "10 minutes" });
  });

  it("takes the Evals tab's commands, and the migration gives them to a store made before them (#801)", async () => {
    // A store whose check predates the eval kinds, as the live one was made.
    await store.owner("alter table ralph.command drop constraint command_kind_check");
    await store.owner("alter table ralph.command add constraint command_kind_check check (kind in ('control','start','restart','stop-now','resume-work','agent-start','mark-read'))");
    await expect(insertCommand("web-evals-old", { kind: "eval-stop", body: { run: "eval-1" } })).rejects.toThrow(/command_kind_check/);
    const migration = readFileSync(join(import.meta.dirname, "migrations", "20261112-eval-commands.sql"), "utf8");
    await store.db.exec(migration);
    // Twice: it is safe to run again.
    await store.db.exec(migration);
    await insertCommand("web-evals-old", { kind: "eval-stop", body: { run: "eval-1" } });
    await insertCommand("web-evals-old", { kind: "eval-start", body: { plan: { source: { kind: "pr", prs: [12] } } } });
    await expect(insertCommand("web-evals-old", { kind: "shell" })).rejects.toThrow(/command_kind_check/);
  });

  it("takes the Test set's commands, and the migration gives them to a store made before them (#856)", async () => {
    // A store whose check predates the test-set kinds, as #801's migration left it.
    await store.owner("alter table ralph.command drop constraint command_kind_check");
    await store.owner("alter table ralph.command add constraint command_kind_check check (kind in ('control','start','restart','stop-now','resume-work','agent-start','mark-read','eval-start','eval-stop'))");
    await expect(insertCommand("web-set-old", { kind: "eval-set-retire", body: { case: "case-1" } })).rejects.toThrow(/command_kind_check/);
    const migration = readFileSync(join(import.meta.dirname, "migrations", "20261119-eval-set-commands.sql"), "utf8");
    await store.db.exec(migration);
    // Twice: it is safe to run again.
    await store.db.exec(migration);
    await insertCommand("web-set-old", { kind: "eval-set-retire", body: { case: "case-1" } });
    await insertCommand("web-set-old", { kind: "eval-set-edit", body: { case: "case-1", notes: "n" } });
    await insertCommand("web-set-old", { kind: "eval-set-add", body: { repo: "o/r", prs: [1], reason: "r" } });
    await insertCommand("web-set-old", { kind: "eval-stop", body: { run: "eval-1" } });
    await expect(insertCommand("web-set-old", { kind: "shell" })).rejects.toThrow(/command_kind_check/);
  });

  it("takes the attach-check command, and the migration gives it to a store made before it (#857)", async () => {
    // A store whose check predates the attach-check kind, as #856's migration left it.
    await store.owner("alter table ralph.command drop constraint command_kind_check");
    await store.db.exec(readFileSync(join(import.meta.dirname, "migrations", "20261119-eval-set-commands.sql"), "utf8"));
    await expect(insertCommand("web-check-old", { kind: "eval-set-check", body: { case: "case-1", test: "a.test.ts" } })).rejects.toThrow(/command_kind_check/);
    const migration = readFileSync(join(import.meta.dirname, "migrations", "20261119-eval-set-check-command.sql"), "utf8");
    await store.db.exec(migration);
    // Twice: it is safe to run again.
    await store.db.exec(migration);
    await insertCommand("web-check-old", { kind: "eval-set-check", body: { case: "case-1", test: "a.test.ts" } });
    await insertCommand("web-check-old", { kind: "eval-set-retire", body: { case: "case-1" } });
    await insertCommand("web-check-old", { kind: "eval-stop", body: { run: "eval-1" } });
    await expect(insertCommand("web-check-old", { kind: "shell" })).rejects.toThrow(/command_kind_check/);
  });

  it("takes the keep command, and the migration gives it to a store made before it (#860)", async () => {
    // A store whose check predates the keep kind, as #857's migration left it.
    await store.owner("alter table ralph.command drop constraint command_kind_check");
    await store.db.exec(readFileSync(join(import.meta.dirname, "migrations", "20261119-eval-set-check-command.sql"), "utf8"));
    await expect(insertCommand("web-keep-old", { kind: "eval-set-keep", body: { case: "case-1" } })).rejects.toThrow(/command_kind_check/);
    const migration = readFileSync(join(import.meta.dirname, "migrations", "20261119-eval-set-keep-command.sql"), "utf8");
    await store.db.exec(migration);
    // Twice: it is safe to run again.
    await store.db.exec(migration);
    await insertCommand("web-keep-old", { kind: "eval-set-keep", body: { case: "case-1" } });
    await insertCommand("web-keep-old", { kind: "eval-set-check", body: { case: "case-1", test: "a.test.ts" } });
    await insertCommand("web-keep-old", { kind: "eval-set-retire", body: { case: "case-1" } });
    await expect(insertCommand("web-keep-old", { kind: "shell" })).rejects.toThrow(/command_kind_check/);
  });

  it("takes the inbox commands, and the migration gives them to a store made before it (#872)", async () => {
    // A store whose check predates the inbox kinds, as #860's migration left it.
    await store.owner("alter table ralph.command drop constraint command_kind_check");
    await store.db.exec(readFileSync(join(import.meta.dirname, "migrations", "20261119-eval-set-keep-command.sql"), "utf8"));
    for (const kind of ["eval-inbox-add", "eval-inbox-start", "eval-inbox-dismiss"]) {
      await expect(insertCommand("web-inbox-old", { kind, body: { entry: "rec-1a2b3c4d" } }), kind).rejects.toThrow(/command_kind_check/);
    }
    const migration = readFileSync(join(import.meta.dirname, "migrations", "20261119-eval-inbox-commands.sql"), "utf8");
    await store.db.exec(migration);
    // Twice: it is safe to run again.
    await store.db.exec(migration);
    await insertCommand("web-inbox-old", { kind: "eval-inbox-add", body: { plan: { source: { kind: "pr", prs: [12] } } } });
    await insertCommand("web-inbox-old", { kind: "eval-inbox-start", body: { entry: "rec-1a2b3c4d" } });
    await insertCommand("web-inbox-old", { kind: "eval-inbox-dismiss", body: { entry: "rec-1a2b3c4d" } });
    await insertCommand("web-inbox-old", { kind: "eval-set-keep", body: { case: "case-1" } });
    await expect(insertCommand("web-inbox-old", { kind: "shell" })).rejects.toThrow(/command_kind_check/);
  });

  it("takes the improver's propose, and the migration gives it to a store made before it (#873)", async () => {
    // A store whose check predates the propose kind, as #872's migration left it.
    await store.owner("alter table ralph.command drop constraint command_kind_check");
    await store.db.exec(readFileSync(join(import.meta.dirname, "migrations", "20261119-eval-inbox-commands.sql"), "utf8"));
    await expect(insertCommand("web-improve-old", { kind: "eval-improve-propose", body: { run: "eval-abc", goal: "quality" } })).rejects.toThrow(/command_kind_check/);
    const migration = readFileSync(join(import.meta.dirname, "migrations", "20261119-eval-improve-command.sql"), "utf8");
    await store.db.exec(migration);
    // Twice: it is safe to run again.
    await store.db.exec(migration);
    await insertCommand("web-improve-old", { kind: "eval-improve-propose", body: { run: "eval-abc", goal: "quality" } });
    await insertCommand("web-improve-old", { kind: "eval-inbox-dismiss", body: { entry: "rec-1a2b3c4d" } });
    await expect(insertCommand("web-improve-old", { kind: "shell" })).rejects.toThrow(/command_kind_check/);
  });

  it("takes the calibrate command, and the migration gives it to a store made before it (#876)", async () => {
    // A store whose check predates the calibrate kind, as #873's migration left it.
    await store.owner("alter table ralph.command drop constraint command_kind_check");
    await store.db.exec(readFileSync(join(import.meta.dirname, "migrations", "20261119-eval-improve-command.sql"), "utf8"));
    const body = { case: "case-1", arms: ["opus", "codex"], axis: "correctness", preferred: "opus", reason: "kept the migration" };
    await expect(insertCommand("web-calibrate-old", { kind: "eval-set-calibrate", body })).rejects.toThrow(/command_kind_check/);
    const migration = readFileSync(join(import.meta.dirname, "migrations", "20261119-eval-set-calibrate-command.sql"), "utf8");
    await store.db.exec(migration);
    // Twice: it is safe to run again.
    await store.db.exec(migration);
    await insertCommand("web-calibrate-old", { kind: "eval-set-calibrate", body });
    await insertCommand("web-calibrate-old", { kind: "eval-improve-propose", body: { run: "eval-abc", goal: "quality" } });
    await insertCommand("web-calibrate-old", { kind: "eval-inbox-dismiss", body: { entry: "rec-1a2b3c4d" } });
    await insertCommand("web-calibrate-old", { kind: "eval-set-keep", body: { case: "case-1" } });
    await expect(insertCommand("web-calibrate-old", { kind: "shell" })).rejects.toThrow(/command_kind_check/);
  });

  it("takes the open-pr command, and the migration gives it to a store made before it (#875)", async () => {
    // A store whose check predates the open-pr kind, as #876's migration left it.
    await store.owner("alter table ralph.command drop constraint command_kind_check");
    await store.db.exec(readFileSync(join(import.meta.dirname, "migrations", "20261119-eval-set-calibrate-command.sql"), "utf8"));
    const body = { proposal: "prop-1a2b3c4d" };
    await expect(insertCommand("web-open-pr-old", { kind: "eval-proposal-open-pr", body })).rejects.toThrow(/command_kind_check/);
    const migration = readFileSync(join(import.meta.dirname, "migrations", "20261120-eval-proposal-open-pr-command.sql"), "utf8");
    await store.db.exec(migration);
    // Twice: it is safe to run again.
    await store.db.exec(migration);
    await insertCommand("web-open-pr-old", { kind: "eval-proposal-open-pr", body });
    await insertCommand("web-open-pr-old", { kind: "eval-set-calibrate", body: { case: "case-1", arms: ["opus", "codex"], axis: "correctness", preferred: "opus", reason: "kept the migration" } });
    await insertCommand("web-open-pr-old", { kind: "eval-improve-propose", body: { run: "eval-abc", goal: "quality" } });
    await expect(insertCommand("web-open-pr-old", { kind: "shell" })).rejects.toThrow(/command_kind_check/);
  });

  it("is refused the 31st command in a minute for one project, not for another", async () => {
    for (let i = 0; i < 30; i++) await insertCommand("web-rate");
    await expect(insertCommand("web-rate")).rejects.toThrow(/rate-limited/);
    await insertCommand("web-rate-other");
  });

  it("counts a rolling minute", async () => {
    await store.owner(
      `insert into ralph.command (project, kind, body, created_at, expires_at)
       select 'web-rolling', 'control', '{}', now() - interval '61 seconds', now() - interval '1 second'
       from generate_series(1, 30)`,
    );
    await insertCommand("web-rolling");
  });

  it("is refused any command while the bridge's lease has run out", async () => {
    await store.lease(-1);
    await expect(insertCommand("web-dead")).rejects.toThrow(/bridge-not-live/);
    await store.owner("delete from ralph.bridge");
    await expect(insertCommand("web-dead")).rejects.toThrow(/bridge-not-live/);
  });

  it("expires a queued command past its expires_at", async () => {
    const [row] = await insertCommand("web-expire", { expiresIn: "-1 second" });
    await store.as(
      "ralph_web",
      "update ralph.command set state = 'expired', why = 'the machine did not pick it up within 60 s', finished_at = now() where id = $1",
      [row!.id],
    );
    expect(await commandRow(row!.id)).toEqual({ state: "expired", why: "the machine did not pick it up within 60 s" });
  });

  it("cannot make any other update", async () => {
    const [live] = await insertCommand("web-update");
    const [past] = await insertCommand("web-update", { expiresIn: "-1 second" });
    const refused = /may only expire a queued command/;
    // Expiring before expires_at.
    await expect(store.as("ralph_web", "update ralph.command set state = 'expired' where id = $1", [live!.id])).rejects.toThrow(refused);
    // Any other transition, even past expires_at.
    for (const state of ["claimed", "done", "refused", "failed"]) {
      await expect(store.as("ralph_web", "update ralph.command set state = $2 where id = $1", [past!.id, state])).rejects.toThrow(refused);
    }
    // Touching only why or finished_at.
    await expect(store.as("ralph_web", "update ralph.command set why = 'x' where id = $1", [past!.id])).rejects.toThrow(refused);
    // Re-expiring a row that is no longer queued.
    await store.owner("update ralph.command set state = 'claimed' where id = $1", [past!.id]);
    await expect(store.as("ralph_web", "update ralph.command set state = 'expired' where id = $1", [past!.id])).rejects.toThrow(refused);
    // Columns outside its grant.
    await expect(store.as("ralph_web", "update ralph.command set result = '{}' where id = $1", [past!.id])).rejects.toThrow(/permission denied/);
    await expect(store.as("ralph_web", "delete from ralph.command where id = $1", [past!.id])).rejects.toThrow(/permission denied/);
    expect(await commandRow(live!.id)).toEqual({ state: "queued", why: null });
  });

  it("upserts a viewer", async () => {
    const upsert = `insert into ralph.viewer (project, last_seen_at) values ($1, now())
                    on conflict (project) do update set last_seen_at = excluded.last_seen_at`;
    await store.as("ralph_web", upsert, ["web-viewer"]);
    await store.as("ralph_web", upsert, ["web-viewer"]);
    expect(await store.as("ralph_web", "select project from ralph.viewer where project = 'web-viewer'")).toEqual([{ project: "web-viewer" }]);
  });
});

describe("as ralph_bridge", () => {
  it("cannot insert a command", async () => {
    await expect(
      store.as("ralph_bridge", "insert into ralph.command (project, kind, body, expires_at) values ('bridge-insert', 'control', '{}', now())"),
    ).rejects.toThrow(/permission denied/);
  });

  it("claims a queued command once, holding the lease", async () => {
    await store.lease(45, "bridge-a");
    const [row] = await insertCommand("bridge-claim");
    const claim = `update ralph.command set state='claimed', claimed_at=now(), claimed_by=$2, attempts=attempts+1
                   where id=$1 and state='queued' and expires_at > now()
                     and exists (select 1 from ralph.bridge where instance=$2 and lease_until > now())
                   returning id, state, claimed_by, attempts`;
    expect(await store.as("ralph_bridge", claim, [row!.id, "bridge-b"])).toEqual([]);
    expect(await store.as("ralph_bridge", claim, [row!.id, "bridge-a"])).toEqual([
      { id: row!.id, state: "claimed", claimed_by: "bridge-a", attempts: 1 },
    ]);
    expect(await store.as("ralph_bridge", claim, [row!.id, "bridge-a"])).toEqual([]);
  });

  it("writes back a result and deletes finished rows", async () => {
    const [row] = await insertCommand("bridge-finish");
    await store.as(
      "ralph_bridge",
      `update ralph.command set state = 'done', finished_at = now() - interval '31 days', http_status = 200, result = '{"outcome":"applied"}'
       where id = $1`,
      [row!.id],
    );
    const deleted = await store.as(
      "ralph_bridge",
      "delete from ralph.command where state in ('done','refused','expired','failed') and finished_at < now() - interval '30 days' returning id",
    );
    expect(deleted).toEqual([{ id: row!.id }]);
  });

  it("writes snapshots and its own row, and only reads viewers", async () => {
    await store.as(
      "ralph_bridge",
      `insert into ralph.snapshot (project, key, body, hash, version) values ('bridge-push', 'dashboard', '\\x1f8b', 'h1', 1)
       on conflict (project, key) do update set body = excluded.body, hash = excluded.hash, version = excluded.version`,
    );
    await store.as("ralph_bridge", "update ralph.bridge set wake = 'poll-only', local = 'ok', controls = 'enabled', schema = 1");
    await store.as("ralph_bridge", "select project from ralph.viewer");
    await expect(store.as("ralph_bridge", "insert into ralph.viewer (project) values ('bridge-push')")).rejects.toThrow(/permission denied/);
    await expect(store.as("ralph_bridge", "update ralph.command set project = 'other'")).rejects.toThrow(/permission denied/);
  });
});

describe("as a Supabase JWT role", () => {
  for (const role of ["anon", "authenticated", "service_role"] as const satisfies readonly StoreRole[]) {
    it(`${role} cannot read schema ralph`, async () => {
      for (const table of ["snapshot", "bridge", "viewer", "command"]) {
        await expect(store.as(role, `select * from ralph.${table}`, [], { claims: { sub: TEST_BRIDGE_UID, role } })).rejects.toThrow(
          /permission denied for schema ralph/,
        );
      }
    });
  }
});

describe("wake-ups", () => {
  beforeEach(async () => {
    await store.owner("truncate realtime.sent");
  });

  it("a command insert sends one private `command` broadcast on ralph:bridge, ids only", async () => {
    const [row] = await insertCommand("wake-command", { body: { loop: "ralph", action: "pause", secret: "never sent" } });
    expect(await store.sent()).toEqual([
      { payload: { project: "wake-command", id: row!.id }, event: "command", topic: "ralph:bridge", private: true },
    ]);
  });

  it("a viewer upsert sends one `viewer` broadcast per write", async () => {
    const upsert = `insert into ralph.viewer (project, last_seen_at) values ($1, now())
                    on conflict (project) do update set last_seen_at = excluded.last_seen_at`;
    await store.as("ralph_web", upsert, ["wake-viewer"]);
    expect(await store.sent()).toEqual([{ payload: { project: "wake-viewer" }, event: "viewer", topic: "ralph:bridge", private: true }]);
    await store.as("ralph_web", upsert, ["wake-viewer"]);
    expect(await store.sent()).toHaveLength(2);
  });

  it("an expiry, a claim or a refused insert sends nothing", async () => {
    const [row] = await insertCommand("wake-quiet", { expiresIn: "-1 second" });
    await store.owner("truncate realtime.sent");
    await store.as("ralph_web", "update ralph.command set state = 'expired', finished_at = now() where id = $1", [row!.id]);
    await store.as("ralph_bridge", "update ralph.command set why = 'seen' where id = $1", [row!.id]);
    await store.lease(-1);
    await expect(insertCommand("wake-quiet")).rejects.toThrow(/bridge-not-live/);
    expect(await store.sent()).toEqual([]);
  });

  it("nobody but the owner can call realtime.send", async () => {
    for (const role of ["ralph_web", "ralph_bridge", "anon", "authenticated"] as const) {
      await expect(store.as(role, "select realtime.send('{}', 'command', 'ralph:bridge', true)")).rejects.toThrow(/permission denied/);
    }
  });
});

describe("the Realtime policy on realtime.messages", () => {
  beforeAll(async () => {
    await store.owner("insert into realtime.messages (topic, event, payload) values ('ralph:bridge', 'command', '{}'), ('other', 'command', '{}')");
  });

  const visible = async (role: StoreRole, topic: string, claims?: Record<string, unknown>) =>
    (await store.as<{ n: number }>(role, "select count(*)::int as n from realtime.messages", [], { claims, settings: { "realtime.topic": topic } }))[0]?.n;

  it("lets the bridge user read topic ralph:bridge", async () => {
    expect(await visible("authenticated", "ralph:bridge", { sub: TEST_BRIDGE_UID, role: "authenticated" })).toBeGreaterThan(0);
  });

  it("hides it from another authenticated user, from anon and on any other topic", async () => {
    expect(await visible("authenticated", "ralph:bridge", { sub: "00000000-0000-4000-8000-000000000001", role: "authenticated" })).toBe(0);
    expect(await visible("authenticated", "ralph:bridge", { role: "authenticated" })).toBe(0);
    expect(await visible("anon", "ralph:bridge", { sub: TEST_BRIDGE_UID, role: "anon" })).toBe(0);
    expect(await visible("authenticated", "other", { sub: TEST_BRIDGE_UID, role: "authenticated" })).toBe(0);
  });

  it("lets nobody broadcast on the topic", async () => {
    for (const role of ["authenticated", "anon"] as const) {
      await expect(
        store.as(role, "insert into realtime.messages (topic, event, payload) values ('ralph:bridge', 'command', '{}')", [], {
          claims: { sub: TEST_BRIDGE_UID, role },
          settings: { "realtime.topic": "ralph:bridge" },
        }),
      ).rejects.toThrow(/row-level security/);
    }
  });
});
