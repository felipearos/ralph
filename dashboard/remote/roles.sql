-- The remote store's two login roles and the Realtime policy (spec
-- felipearos/ralph#165, §7 "Least privilege").
--
-- Run once by the migration owner, after `schema.sql`, with the secrets as
-- psql variables so none is ever committed:
--
--   psql "$OWNER_URL" -v ON_ERROR_STOP=1 \
--     -v web_password=… -v bridge_password=… -v bridge_uid=<bridge Auth user uuid> \
--     -f dashboard/remote/roles.sql
--
-- `ralph_web` (the Vercel app) reads state and writes intent; `ralph_bridge`
-- (the machine) writes state and executes intent. Both log in, inherit
-- nothing and own nothing, so neither can CREATE, ALTER or TRUNCATE. The
-- `ralph` tables use column grants and triggers, not RLS: no JWT role reaches
-- the schema at all. RLS is used only where Supabase requires it, on
-- `realtime.messages`.

create role ralph_web login noinherit password :'web_password';
create role ralph_bridge login noinherit password :'bridge_password';

-- Nobody but the two roles reaches schema ralph, whatever default privileges
-- the platform grants on new tables and functions.
revoke all on schema ralph from public, anon, authenticated, service_role;
revoke all on all tables in schema ralph from public, anon, authenticated, service_role;
revoke all on all functions in schema ralph from public, anon, authenticated, service_role;
revoke create on schema public from ralph_web, ralph_bridge;
grant usage on schema ralph to ralph_web, ralph_bridge;

-- ralph_web: read state, write intent, nothing else.
grant select on ralph.snapshot, ralph.bridge to ralph_web;
-- `id` too: the app picks it, so the row's id is the `body.id` every local
-- write path records the command under (spec §5, "Insert").
grant select, insert (id, project, kind, body, expires_at) on ralph.command to ralph_web;
grant update (state, why, finished_at) on ralph.command to ralph_web;  -- only to expire; a trigger allows only queued→expired past expires_at
grant select, insert, update (last_seen_at) on ralph.viewer to ralph_web;

-- ralph_bridge: write state, execute intent.
grant select, insert, update on ralph.snapshot, ralph.bridge to ralph_bridge;
grant select, update (state, claimed_at, claimed_by, attempts, finished_at, http_status, result, why) on ralph.command to ralph_bridge;
grant delete on ralph.command to ralph_bridge;  -- the 30-day prune
grant select on ralph.viewer to ralph_bridge;

-- Realtime: only the bridge's Auth user may join the wake topic. There is no
-- insert policy, so no client can broadcast on it; only `ralph.wake()` can.
create policy "bridge reads its wake topic" on realtime.messages
  for select to authenticated
  using (realtime.topic() = 'ralph:bridge' and (select auth.uid()) = :'bridge_uid'::uuid);
