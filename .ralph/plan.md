# Ralph plan — scope fences

GitHub's dependency graph, issue state, and the frontier tool are the source
of truth for what can be worked next. This file (committed in the project as
`.ralph/plan.md`, or wherever `plan` in `.ralph/config.json` points) carries
only the work the loops must never take; the harness prompt passes these issue
numbers to the frontier request as exclusions, and the frontier gate reads them
from `origin/<baseBranch>`.

## Out of scope — never pick

<!-- The 2026-09-29 hold on 166–170 ended when they merged on 2026-10-09. The
     numbers carry no # here: this section is machine-read, and a `#<n>` inside
     a comment is still a fence. -->

- #176 (HITL only: provisions Supabase and Vercel and needs the operator's accounts).
- #177 (deferred: the optional live output tail).
- #317, #318, #319, #320, #321, #322, #323 (the clerk chain under spec 315: an Orca
  orchestrator builds them in order, so they carry no state label on purpose,
  and neither a coder nor the triager's intake may take them).
- #332, #333, #334, #335, #336, #337, #338, #339, #340 (the tracker chain under
  spec 330: held for the operator to build outside the loops, fenced for the
  same reason as the clerk chain).

## Parent closure exceptions

- Parent/spec issues: #165, #315, #330. These close only when all their children are
  done; closing them (with a summary comment) IS a valid maintenance task once
  the children are merged, but never "implement" them. They are not passed to
  `--exclude`: the frontier treats a parent as a container, and a closure is an
  explicit follow-up rather than a candidate implementation ticket.
