-- The intake page's own read of the store (felipearos/ralph#459).
--
-- The remote dashboard sits behind Vercel Authentication, which only the
-- operator's Vercel account gets past; the team reading the Slack canvas has
-- no such account. So the intake page can also be deployed on its own, as a
-- second Vercel project with Vercel Authentication off and
-- RALPH_REMOTE_SURFACE=intake, which serves the intake routes and nothing
-- else. That deployment logs in as `ralph_intake`, which can read the two
-- intake snapshot keys and nothing more: not the loops, not the commands,
-- not the bridge. A defect in the open deployment can then show nothing but
-- what the page shows.
--
-- Run once by the migration owner, after `schema.sql` and `roles.sql`, and
-- only when the open intake deployment is wanted:
--
--   psql "$OWNER_URL" -v ON_ERROR_STOP=1 -v intake_password=… -f dashboard/remote/intake.sql
--
-- The metrics key is readable here too: the function, not the role, holds it
-- behind the metrics password, exactly as on the main deployment.

-- security_barrier: the key filter runs before any predicate a caller adds,
-- so no function in a WHERE clause sees a row of another key.
create view ralph.intake_snapshot with (security_barrier) as
  select project, key, body, hash, version, pushed_at, problem
  from ralph.snapshot
  where key in ('intake', 'intake-metrics');

create role ralph_intake login noinherit password :'intake_password';

revoke all on ralph.intake_snapshot from public, anon, authenticated, service_role;
revoke create on schema public from ralph_intake;
grant usage on schema ralph to ralph_intake;
grant select on ralph.intake_snapshot to ralph_intake;
-- The main deployment needs none of this: as `ralph_web` it reads the two
-- keys from `ralph.snapshot` like every other key.
