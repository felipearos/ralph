# Ralph plan — scope fences

GitHub's dependency graph, issue state, and the frontier tool are the source
of truth for what can be worked next. This file deliberately carries only the
work Ralph must never take; the harness prompt passes these issue numbers to the
frontier request as exclusions.

## Out of scope — never pick

- #228 (Renovate dashboard), #65 (held for music launch), #428 (HITL only —
  touches host machine config).

## Parent closure exceptions

- Parent/spec issues: #542, #507, #528, #759, #760, #761, #762. These close only when all their
  children are done; closing them (with a summary comment) IS a valid
  maintenance task once the children are merged, but never "implement" them.
  They are not passed to `--exclude`: the frontier treats a parent as a
  container, and a closure is an explicit follow-up rather than a candidate
  implementation ticket.
