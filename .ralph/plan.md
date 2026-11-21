# Ralph plan — scope fences

GitHub's dependency graph, issue state, and the frontier tool are the source
of truth for what can be worked next. This file (committed in the project as
`.ralph/plan.md`, or wherever `plan` in `.ralph/config.json` points) carries
only the work the loops must never take; the harness prompt passes these issue
numbers to the frontier request as exclusions, and the frontier gate reads them
from `origin/<baseBranch>`.

<!-- The numbers here are this repository's, which numbers from 1 again since
     the 2026-11-20 move. The fences written before it (the clerk and tracker
     chains, the Supabase provisioning ticket) named private-archive issues;
     those chains are merged or closed there, and keeping their numbers would
     fence unrelated new issues here as they reach them. The numbers carry
     no # in this comment: this section is machine-read, and a `#<n>` inside a
     comment is still a fence. -->

## Out of scope — never pick

- #1 (deferred: the optional live output tail of the remote dashboard).
- #8 (needs an OpenCode runner, and this host has none: the judge it adds
  could not be run or tested end to end here).

## Parent closure exceptions

- Parent/spec issues: #7. It closes only when all its children are done;
  closing it (with a summary comment) IS a valid maintenance task once the
  children are merged, but never "implement" it. It is not passed to
  `--exclude`: the frontier treats a parent as a container, and a closure is an
  explicit follow-up rather than a candidate implementation ticket.
