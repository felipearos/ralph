-- The Evals tab's relayed commands (#801): `eval-start` and `eval-stop`.
--
-- `schema.sql` creates `ralph.command` with this check for a new store. A
-- store created before it keeps the old list, and refuses an eval command's
-- insert with a check violation: the remote page shows that error, and
-- nothing else changes. Run once by the migration owner (Supabase's
-- `postgres`), as `schema.sql` is:
--
--   psql "$SUPABASE_DB_URL" -f dashboard/remote/migrations/20261112-eval-commands.sql
alter table ralph.command drop constraint if exists command_kind_check;
alter table ralph.command add constraint command_kind_check
  check (kind in ('control','start','restart','stop-now','resume-work','agent-start','mark-read','eval-start','eval-stop'));
