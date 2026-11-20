-- The Test set screen's relayed commands (#856): `eval-set-add`,
-- `eval-set-edit` and `eval-set-retire`.
--
-- `schema.sql` creates `ralph.command` with this check for a new store. A
-- store created before it keeps the old list, and refuses a test-set
-- command's insert with a check violation: the remote page shows that error,
-- and nothing else changes. Run once by the migration owner (Supabase's
-- `postgres`), as `schema.sql` is:
--
--   psql "$SUPABASE_DB_URL" -f dashboard/remote/migrations/20261119-eval-set-commands.sql
alter table ralph.command drop constraint if exists command_kind_check;
alter table ralph.command add constraint command_kind_check
  check (kind in ('control','start','restart','stop-now','resume-work','agent-start','mark-read','eval-start','eval-stop','eval-set-add','eval-set-edit','eval-set-retire'));
