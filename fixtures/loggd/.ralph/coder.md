<!-- ralph:section RAILS -->
- **Schema edits only.** You may edit `src/server/db/schema.ts` and let
  the orchestrator generate the migration, but never apply one and never run
  SQL. Applying even a development migration remains a human release step.
- **Never run e2e or Playwright.** Nobody in this loop does — CI owns e2e.

<!-- ralph:section CONVENTIONS -->
## Conventions (the repo's AGENTS.md (imported by CLAUDE.md) and .claude/skills are loaded — follow them)

- **`CONTEXT.md` at the repo root is the domain glossary, and it is binding.**
  Name concepts the way it names them, and never use a synonym its `_Avoid_`
  line rules out. A term it defines has a precise meaning — a Media Reference
  is media-type-specific and provider-aware, so it must never be reduced to a
  bare external ID. If the brief and the glossary disagree, follow the
  glossary and say so in your report.
- Web imports use `~/` from `src/`; mobile imports use `@/`. Never mix.
- Plain `<img>`, never `next/image`.
- No `/N` colour-opacity syntax (`bg-black/40`) — solid palette tokens only.
- Semantic Tailwind typography and colour tokens, shared primitives first.
- Drizzle query builder only; never concatenate SQL. Verify the session on
  the server before any mutation.
- Never add a production import from a devDependency.
- New UI component → a Storybook story. Fold skeletons into an existing story
  render; never add a new exported story object for one.
- Any movie-returning endpoint must gate adult titles by the viewer's
  preference.

<!-- ralph:section GATES -->
Here that means `bun run typecheck` and targeted `bun run test <paths>` are
yours; everything repo-wide is the orchestrator's. Never write an env file and
never run `doppler`.

Run `bun run typecheck` and `bun run test <paths>` for the files you touched,
and fix what they surface. When you touch web `.tsx` under `src/`, also run
`bun run lint:shadcn` — it reports only the design-system findings your
branch introduces, not ones the file already had — and fix every finding; its message names the token, size or
variant to use instead. `bun run lint:shadcn --all <paths>` lists every
finding in those files, not just your lines. Always pass paths: never run `bun run test` bare
(the full suite), repo-wide `bun lint`, `bun run build`, Storybook, dev
servers or e2e. The executor guard refuses those, and retrying one under
another spelling (`bunx vitest`, `npx eslint .`) is refused the same way.

`bun run typecheck` is TS7 and disagrees with the TS5.9 used by `next build`,
so a clean typecheck is necessary, not sufficient — the orchestrator runs the
rest.
