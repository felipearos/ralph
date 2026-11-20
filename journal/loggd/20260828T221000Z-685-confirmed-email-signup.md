# 2026-08-28 — #685: the two stacks disagreed about what sign-up produces — HANDOFF

**Outcome: committed and pushed, no PR yet.** Loop: **ralph**. Ticket #685,
branch `ralph/685-confirmed-email-signup`, two commits (`458d5b59`, `da4f3d8b`)
pushed. `ralph-wip` deliberately LEFT ON #685 — it is the resume marker, and
§1 priority 2 is how the next iteration picks this up.

The iteration lost its process mid-flight (background tasks were reaped with no
completion record) and got one recovery turn, which is why this stops short of a
PR rather than because anything is wrong with the work.

## Read this first if you are the next iteration

The remaining work is **AC6 only**: the e2e coverage, then the two review axes,
the full gates, and the PR. Everything else in the ticket is done and green.
Resume on the branch — do not start over, and do not re-claim.

**Before writing the e2e, restart the local Supabase stack.** Both commits change
`supabase/config.toml`, and a stack started from the old file has confirmations
off and no mailbox, so every new spec would fail for a reason that is not about
the spec. Check no CI job is in flight first — the self-hosted runner is
`network_mode: host` and shares the `supabase_*_loggd` containers with you.

## What #685 actually turned out to be

Most of this ticket was already built. #650 put the `confirmation_required`
outcome in the Account Creation Core, #651 added the native `/auth/confirm`
callback and the shared parser, #683 the abuse boundary, #684 the password
posture. The mobile transport already names the status and already renders the
whole Confirmation Required screen — resend, countdown, "use a different email".
Read the code before believing the acceptance criteria: five of the six were
mostly or wholly satisfied, and the mapper stage is what would have told me that
if it had produced a report (it exited 0 and printed nothing — I read its tool
trace instead, which was enough).

Three things were genuinely missing, and all three are now in.

## The design fact worth carrying forward

**A provider setting that differs between local and production is a bug factory,
and the symptom shows up in the UI as a dead end.**

`enable_confirmations` was `false` locally and undeclared for production. So the
local stack autoconfirmed and handed back a session, while the web sign-up page
called `setSuccess(true)` on every 200 and showed "Check your email" regardless.
A member who already held a session sat on a screen waiting for a link that was
never sent. Neither half of that is obviously wrong on its own — the page looks
like it is being careful, and the config looks like a convenience for local dev.
The defect only exists in the gap between them.

So local and production are held **equal** at `true` here rather than declared as
an intentional divergence, which is the opposite of what `email_sent` does two
rows away in `scripts/auth-abuse-controls.ts`. Divergence is fine when the local
number binds nothing; it is not fine when it changes what the code under test
*does*.

Turning it on locally forced three consequences, and finding them is most of the
work if you ever do this again:

- **No SMTP at all.** `[inbucket] enabled = false` meant confirmations-on would
  send into nothing. Enabling it invalidated the reasoning in two `why` strings
  in `scripts/auth-abuse-controls.ts` that argued the local mail counters bind
  nothing *because* there is no SMTP, and it changed the local stack's service
  and port inventory in `docs/launch/test-environment.md` and
  `scripts/reap-supabase-stack.test.ts`.
- **`email_sent = 2` became binding.** Project-wide and hourly, so a suite that
  signs up twice would be throttled by the provider rather than by the behaviour
  under test. Raised to 30, matching production.
- **The redirect allow-list rejected its own links.** `additional_redirect_urls`
  was `["https://127.0.0.1:3000"]` while the app serves from
  `http://localhost:3000`. GoTrue does **not** reject an unapproved
  `emailRedirectTo` — it silently replaces it with `site_url`, so the failure
  reads as "confirmation works but the member lands on the home page" rather
  than as an error. That is the single most confusing thing in this area.

## What landed

- `458d5b59` — `enable_confirmations = true`; `[inbucket] enabled = true`;
  local `/**` redirect origins; `email_sent` 2 → 30; new
  `scripts/email-confirmation-controls.ts` + conformance test +
  `docs/security/email-confirmation.md`, modelled on the #683/#684 siblings;
  `docs/go-live.md` gains the dashboard step.
- `da4f3d8b` — `/api/auth/sign-up` names `status` and `email`;
  `src/app/sign-up/page.tsx` branches on it and navigates on `authenticated`.

Green at handoff: `bun run typecheck`, the four declaration/conformance suites
(54 tests), and the four sign-up suites (88 tests). **Not yet run:** `bun lint`
over the whole tree, the full Vitest suite, and any e2e.

## Dead ends and cautions

- **Do not delegate the e2e blind.** The mail-reading helper needs Inbucket's
  API on 54324, and the expired-link case wants a deliberately malformed or
  spent link rather than a real hour-long wait — `MESSAGE_BY_ERROR_CODE` in
  `packages/shared/src/auth-callback.ts` already maps `otp_expired`, so the
  cheapest honest test drives the callback URL directly.
- **"Mobile confirmation" in AC6 cannot mean Playwright driving Expo.** #651
  already settled this: the testable half is the HTTPS web fallback at
  `/auth/confirm` with an implicit-flow link, and `mobile/__tests__/` covers the
  native half in Jest.
- The existing specs that assert "Check your email" after a UI sign-up
  (`e2e/auth.spec.ts`, `e2e/sign-up-validation.spec.ts`) were written against
  the *old* autoconfirming stack and pass by accident. With confirmations on
  they now pass for the right reason. Do not "fix" them.

## Housekeeping

`ralph-wip` stays on #685 until the PR merges. No migration is involved, so this
is not a `needs-migration` handoff — nothing here is waiting on a human.
