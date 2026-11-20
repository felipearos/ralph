/**
 * The remote store in a test: PGlite (Postgres compiled to wasm) with the
 * Supabase pieces the store leans on, then `schema.sql` and `roles.sql`
 * applied exactly as the owner runs them.
 *
 * The Supabase shim is the smallest stand-in that keeps the store's own SQL
 * unchanged:
 *
 * - roles `anon`, `authenticated` and `service_role`, granted everything on
 *   new tables and functions by default, the worst case `roles.sql` must
 *   revoke;
 * - schema `realtime` with `messages` (RLS on, readable and writable by
 *   `anon`/`authenticated` as far as policies allow), `topic()` reading the
 *   `realtime.topic` setting, and `send()`, which records each call in
 *   `realtime.sent` instead of broadcasting;
 * - schema `auth` with `uid()` reading `sub` from `request.jwt.claims`.
 *
 * `serve()` puts the store on a Postgres wire endpoint, so a client in another
 * process (the bridge, in the end-to-end test) reaches it as it would reach
 * Supabase's pooler.
 *
 * Bridge, relay, handler and end-to-end tests import this; keep its surface
 * to `createTestStore` and the `TestStore` methods.
 */
import { readFileSync } from "node:fs";
import { createServer, type AddressInfo, type Socket } from "node:net";

import { PGlite, type Transaction } from "@electric-sql/pglite";

/** The bridge's Supabase Auth user in tests; the Realtime policy names it. */
export const TEST_BRIDGE_UID = "00000000-0000-4000-8000-00000000b1d6";

/** Every role a test can act as. `postgres` is the migration owner. */
export type StoreRole = "postgres" | "ralph_web" | "ralph_bridge" | "ralph_intake" | "anon" | "authenticated" | "service_role";

/** How a statement runs: as a role, with a JWT's claims and any other settings. */
export interface AsOptions {
  /** The decoded JWT, as PostgREST and Realtime set `request.jwt.claims`. */
  claims?: Record<string, unknown>;
  /** Transaction-local settings, for example `{ "realtime.topic": "ralph:bridge" }`. */
  settings?: Record<string, string>;
}

/** One recorded `realtime.send(payload, event, topic, private)`. */
export interface SentWake {
  payload: Record<string, unknown>;
  event: string;
  topic: string;
  private: boolean;
}

export interface TestStore {
  /** The database itself, as the owner. Prefer `as` and `owner`. */
  readonly db: PGlite;
  /** Run `sql` with `params` as the owner (a superuser here) and return the rows. */
  owner<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /**
   * Run `sql` with `params` as `role` in its own transaction, with `claims`
   * and `settings` set for that transaction only, and return the rows. A
   * statement Postgres refuses rejects with its error.
   */
  as<T = Record<string, unknown>>(role: StoreRole, sql: string, params?: unknown[], options?: AsOptions): Promise<T[]>;
  /** Give the bridge row a lease of `seconds` from now (negative: one that has run out). */
  lease(seconds: number, instance?: string): Promise<void>;
  /** The `realtime.send` calls so far, oldest first. */
  sent(): Promise<SentWake[]>;
  /** Listen for Postgres clients on an ephemeral loopback port. */
  serve(): Promise<WireEndpoint>;
  close(): Promise<void>;
}

/** The store on the wire. */
export interface WireEndpoint {
  /** A connection URL whose every statement runs as `role`, as that role's login would. */
  url(role: StoreRole): string;
  /** Stop listening and drop every client. */
  close(): Promise<void>;
}

const SUPABASE_SHIM = `
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;

alter default privileges grant all on tables to anon, authenticated, service_role;
alter default privileges grant all on functions to anon, authenticated, service_role;
alter default privileges grant all on sequences to anon, authenticated, service_role;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid
$$;

create schema realtime;
grant usage on schema realtime to anon, authenticated, service_role;
create table realtime.messages (
  id bigserial primary key,
  topic text not null,
  extension text not null default 'broadcast',
  payload jsonb,
  event text,
  private boolean default true,
  inserted_at timestamptz not null default now()
);
alter table realtime.messages enable row level security;
create function realtime.topic() returns text language sql stable as $$
  select nullif(current_setting('realtime.topic', true), '')
$$;
create table realtime.sent (
  seq bigserial primary key,
  payload jsonb not null,
  event text not null,
  topic text not null,
  private boolean not null
);
revoke all on realtime.sent from anon, authenticated, service_role;
create function realtime.send(payload jsonb, event text, topic text, private boolean default true)
  returns void language sql as $$
  insert into realtime.sent (payload, event, topic, private) values (payload, event, topic, private)
$$;
revoke execute on function realtime.send(jsonb, text, text, boolean) from public, anon, authenticated, service_role;
`;

const sqlFile = (name: string): string => readFileSync(new URL(name, import.meta.url), "utf8");

const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/** Substitute psql's `:'name'` variables as quoted literals, as `psql -v` does. */
export function withPsqlVariables(sql: string, variables: Record<string, string>): string {
  return sql.replace(/:'([A-Za-z_][A-Za-z0-9_]*)'/g, (_, name: string) => {
    const value = variables[name];
    if (value === undefined) throw new Error(`psql variable ${name} is not set`);
    return literal(value);
  });
}

const SSL_REQUEST = 80877103;
const CANCEL_REQUEST = 80877102;
const STORE_ROLES: readonly StoreRole[] = ["postgres", "ralph_web", "ralph_bridge", "ralph_intake", "anon", "authenticated", "service_role"];

/** A simple-protocol `Query` message. */
const queryMessage = (sql: string): Uint8Array => {
  const text = Buffer.from(`${sql}\0`, "utf8");
  const message = Buffer.alloc(5 + text.length);
  message.write("Q", 0, "latin1");
  message.writeInt32BE(4 + text.length, 1);
  text.copy(message, 5);
  return message;
};

/** A `Sync` message. */
const SYNC = new Uint8Array([0x53, 0, 0, 0, 4]);

/** The `user` a StartupMessage names. */
const startupUser = (message: Buffer): string | null => {
  const fields = message.subarray(8).toString("utf8").split("\0");
  const at = fields.indexOf("user");
  return at === -1 ? null : (fields[at + 1] ?? null);
};

/** How long a client may keep the session between two of its messages before it is cut off. */
const CLIENT_STALL_MS = 5_000;

/**
 * Serve one client connection off the one PGlite backend.
 *
 * PGlite is a single session, so a client holds it, under both of PGlite's
 * locks, from its first message after a `Sync` up to and including the next
 * `Sync` (or a simple `Query`): no other client's statement and no in-process
 * transaction lands between its `Parse`/`Describe`/`Flush` round trip and its
 * `Execute`. Each such turn runs as the role the client logged in as (`SET
 * ROLE`, then `RESET ROLE`): PGlite trusts every login, so this is what keeps
 * the role's grants in force. A client that stalls mid-turn (a stopped
 * process) is cut off after `CLIENT_STALL_MS`, so it cannot wedge the store.
 * Clients must not hold a transaction open across turns; the bridge and the
 * handler never do.
 */
function serveClient(db: PGlite, socket: Socket): void {
  /** A run of messages, `end` when it closes the turn; null when the client is gone. */
  type Chunk = { messages: Buffer[]; end: boolean } | null;
  let pending: Buffer = Buffer.alloc(0);
  let chunk: Buffer[] = [];
  let role: StoreRole | null = null;
  const inbox: Chunk[] = [];
  let notify: (() => void) | null = null;
  let turn = false;

  const exec = (message: Uint8Array): Promise<Uint8Array> => db.execProtocolRaw(message);

  /** The client's next chunk; null once it is gone or has stalled. */
  const next = async (): Promise<Chunk> => {
    while (inbox.length === 0) {
      const arrived = await new Promise<boolean>((resolve) => {
        notify = () => resolve(true);
        setTimeout(() => resolve(false), CLIENT_STALL_MS).unref();
      });
      if (!arrived) return null;
    }
    return inbox.shift()!;
  };

  const startTurn = (): void => {
    turn = true;
    const scoped = role !== null && role !== "postgres" ? role : null;
    void db
      ._runExclusiveTransaction(() =>
        db.runExclusive(async () => {
          // `role` is one of `STORE_ROLES`, so it is safe to splice as an identifier.
          if (scoped !== null) await exec(queryMessage(`set role "${scoped}"`));
          try {
            for (;;) {
              const current = await next();
              if (current === null) {
                // Gone or stalled mid-turn: end the implicit transaction it left open.
                await exec(SYNC);
                socket.destroy();
                return;
              }
              const out: Uint8Array[] = [];
              for (const message of current.messages) out.push(await exec(message));
              if (!socket.destroyed) socket.write(Buffer.concat(out));
              if (current.end) return;
            }
          } finally {
            if (scoped !== null) await exec(queryMessage("reset role"));
          }
        }),
      )
      .catch(() => socket.destroy())
      .finally(() => {
        turn = false;
        if (inbox.length > 0 && inbox[0] !== null) startTurn();
      });
  };

  const deliver = (arrived: Chunk): void => {
    inbox.push(arrived);
    const wake = notify;
    notify = null;
    wake?.();
    if (!turn && arrived !== null) startTurn();
  };

  const drain = (): void => {
    for (;;) {
      if (role === null) {
        if (pending.length < 8) return;
        const length = pending.readInt32BE(0);
        if (pending.length < length) return;
        const code = pending.readInt32BE(4);
        const message = pending.subarray(0, length);
        pending = pending.subarray(length);
        if (code === SSL_REQUEST) {
          socket.write("N");
          continue;
        }
        const user = code === CANCEL_REQUEST ? null : startupUser(message);
        if (user === null || !STORE_ROLES.includes(user as StoreRole)) {
          socket.destroy();
          return;
        }
        // PGlite answers the startup itself, as the owner; the role applies from the next turn.
        deliver({ messages: [message], end: true });
        role = user as StoreRole;
        continue;
      }
      if (pending.length < 5) return;
      const length = 1 + pending.readInt32BE(1);
      if (pending.length < length) return;
      const type = String.fromCharCode(pending[0]!);
      const message = pending.subarray(0, length);
      pending = pending.subarray(length);
      if (type === "X") {
        socket.end();
        return;
      }
      chunk.push(message);
      if (type === "S" || type === "Q" || type === "H") {
        deliver({ messages: chunk, end: type !== "H" });
        chunk = [];
      }
    }
  };

  socket.on("data", (data: Buffer) => {
    pending = pending.length === 0 ? data : Buffer.concat([pending, data]);
    drain();
  });
  socket.on("close", () => {
    if (turn) deliver(null);
  });
  socket.on("error", () => {});
}

/** Boot a fresh store: the shim, then `schema.sql`, `roles.sql` and `intake.sql`. */
export async function createTestStore(options: { bridgeUid?: string } = {}): Promise<TestStore> {
  const db = await PGlite.create();
  await db.exec(SUPABASE_SHIM);
  await db.exec(sqlFile("./schema.sql"));
  await db.exec(
    withPsqlVariables(sqlFile("./roles.sql"), {
      web_password: "test-web",
      bridge_password: "test-bridge",
      bridge_uid: options.bridgeUid ?? TEST_BRIDGE_UID,
    }),
  );
  // The open intake deployment's role (felipearos/ralph#459), as an operator would add it.
  await db.exec(withPsqlVariables(sqlFile("./intake.sql"), { intake_password: "test-intake" }));

  const owner = async <T>(sql: string, params: unknown[] = []): Promise<T[]> =>
    (await db.query<T>(sql, params)).rows;

  const as = <T>(role: StoreRole, sql: string, params: unknown[] = [], options: AsOptions = {}): Promise<T[]> =>
    db.transaction(async (tx: Transaction) => {
      const settings: Record<string, string> = { ...options.settings };
      if (options.claims !== undefined) settings["request.jwt.claims"] = JSON.stringify(options.claims);
      for (const [name, value] of Object.entries(settings)) {
        await tx.query("select set_config($1, $2, true)", [name, value]);
      }
      // `role` is a closed union, so it is safe to splice as an identifier.
      await tx.exec(`set local role "${role}"`);
      return (await tx.query<T>(sql, params)).rows;
    });

  return {
    db,
    owner,
    as,
    async lease(seconds, instance = "test-bridge") {
      await owner(
        `insert into ralph.bridge (instance, lease_until, last_seen_at)
         values ($1, now() + make_interval(secs => $2), now())
         on conflict (singleton) do update
           set instance = excluded.instance, lease_until = excluded.lease_until, last_seen_at = excluded.last_seen_at`,
        [instance, seconds],
      );
    },
    async sent() {
      return owner<SentWake>("select payload, event, topic, private from realtime.sent order by seq");
    },
    async serve() {
      const sockets = new Set<Socket>();
      const server = createServer((socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        serveClient(db, socket);
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as AddressInfo;
      return {
        url: (role) => `postgres://${role}@127.0.0.1:${port}/postgres?sslmode=disable`,
        close: () =>
          new Promise<void>((resolve) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => resolve());
          }),
      };
    },
    close: () => db.close(),
  };
}
