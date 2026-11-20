<!-- ralph:section CONVENTIONS -->
## Conventions

- Read `CLAUDE.md` at the repository root; match the surrounding code's style,
  naming and comment density.

<!-- ralph:section GATES -->
Run `bun run typecheck` and the targeted `bun x vitest run <paths>` for what
you touched, and fix what they surface. A test file that spawns a process
calls `subprocessSuite("<what it spawns>")` from `test-timeouts.ts` at the top.
