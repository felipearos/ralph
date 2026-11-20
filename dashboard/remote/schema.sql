-- The remote dashboard's hosted store (spec felipearos/ralph#165, §4, §5).
--
-- Everything lives in schema `ralph`, never `public`: Supabase exposes
-- `public` through its Data API, and `ralph` is not in the exposed schemas.
-- The bridge pushes snapshots and holds the lease; the Vercel app reads
-- snapshots and writes command rows. Who may do what is `roles.sql`.
--
-- Run once by the migration owner (Supabase's `postgres`), before `roles.sql`.
-- The functions below are owned by whoever runs this, which is the point:
-- `ralph.wake()` runs as that owner and neither login role can call it.

create schema ralph;

-- One row per (project, key), overwritten in place. `body` is gzip(compact
-- JSON), served as is; a key the bridge could not store carries `problem`
-- (for example "too-large") instead. One key is at most 1 MB after gzip.
create table ralph.snapshot (
  project   text not null,
  key       text not null,
  body      bytea check (octet_length(body) <= 1048576),
  hash      text,
  version   bigint,
  pushed_at timestamptz default now(),
  problem   text,
  primary key (project, key)
);

-- The bridge's one row: its lease, heartbeat and what it reports about the
-- machine. `singleton` keeps it to one row; an upsert targets it.
create table ralph.bridge (
  singleton    boolean primary key default true check (singleton),
  instance     text,
  lease_until  timestamptz,
  last_seen_at timestamptz,
  schema       int,
  local        text check (local in ('ok', 'dashboard-down', 'redactor-degraded')),
  wake         text check (wake in ('realtime', 'poll-only')),
  controls     text check (controls in ('enabled', 'disabled')),
  hot          jsonb,  -- project → hot-until
  problem      text
);

-- One row per project: when a page last read it. The app upserts it; the
-- bridge reads it and turns the project hot.
create table ralph.viewer (
  project      text primary key,
  last_seen_at timestamptz
);

create table ralph.command (
  id uuid primary key default gen_random_uuid(),
  project text not null,
  kind text not null check (kind in ('control','start','restart','stop-now','resume-work','agent-start','mark-read','eval-start','eval-stop','eval-set-add','eval-set-edit','eval-set-retire','eval-set-check','eval-set-keep','eval-inbox-add','eval-inbox-start','eval-inbox-dismiss','eval-improve-propose','eval-set-calibrate','eval-proposal-open-pr')),
  body jsonb not null check (octet_length(body::text) <= 4096),
  state text not null default 'queued' check (state in ('queued','claimed','done','refused','expired','failed')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null check (expires_at <= created_at + interval '10 minutes'),
  claimed_at timestamptz, claimed_by text, attempts int not null default 0,
  -- `result` is `json`, not `jsonb`: it keeps the local route's answer as
  -- the bridge read it, key order included, so the app returns it byte for byte.
  finished_at timestamptz, http_status int, result json, why text
);
create index command_pending on ralph.command (created_at) where state in ('queued','claimed');

-- The backstop behind the app's own checks: at most 30 commands per project
-- in a rolling minute, and none while the bridge is not live (its lease has
-- run out, so nothing could claim the row). The advisory lock makes two
-- concurrent inserts for one project count each other.
create function ralph.command_admit() returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtext('ralph.command:' || new.project));
  if (select count(*) from ralph.command
      where project = new.project and created_at > now() - interval '1 minute') >= 30 then
    raise exception 'rate-limited'
      using detail = format('project %s already has 30 commands in the last minute', new.project);
  end if;
  if not exists (select 1 from ralph.bridge where lease_until > now()) then
    raise exception 'bridge-not-live'
      using detail = 'no bridge holds a lease, so nothing could claim the command';
  end if;
  return new;
end
$$;

create trigger command_admit
  before insert on ralph.command
  for each row execute function ralph.command_admit();

-- `ralph_web` may update a command only to expire it: `queued → expired`
-- once `expires_at` has passed, setting `why` and `finished_at` with it. Its
-- column grants already keep it off every other column; this pins the
-- transition. It reads `current_user`, so it must stay SECURITY INVOKER.
create function ralph.command_web_expire_only() returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  if old.state = 'queued' and new.state = 'expired' and now() > old.expires_at
     and (to_jsonb(new) - array['state', 'why', 'finished_at'])
         = (to_jsonb(old) - array['state', 'why', 'finished_at']) then
    return new;
  end if;
  raise exception 'ralph_web may only expire a queued command past its expires_at'
    using detail = format('command %s: %s → %s', old.id, old.state, new.state);
end
$$;

create trigger command_web_expire_only
  before update on ralph.command
  for each row when (current_user = 'ralph_web')
  execute function ralph.command_web_expire_only();

-- The wake-up: a Realtime Broadcast from the database on the private topic
-- `ralph:bridge`. The payload is ids only, never `body`; a wake-up is a hint
-- and the bridge reads the row itself. SECURITY DEFINER so the triggers can
-- send whoever inserts, with `execute` revoked so nobody can call it by hand.
create function ralph.wake() returns trigger
  language plpgsql
  security definer
  set search_path = ''
as $$
begin
  if tg_table_name = 'command' then
    perform realtime.send(jsonb_build_object('project', new.project, 'id', new.id), 'command', 'ralph:bridge', true);
  else
    perform realtime.send(jsonb_build_object('project', new.project), 'viewer', 'ralph:bridge', true);
  end if;
  return null;
end
$$;
revoke execute on function ralph.wake() from public;

create trigger command_wake
  after insert on ralph.command
  for each row execute function ralph.wake();

create trigger viewer_wake
  after insert or update of last_seen_at on ralph.viewer
  for each row execute function ralph.wake();
