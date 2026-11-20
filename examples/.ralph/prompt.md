The operator has granted this loop permission to merge its own PRs when the
gates below pass.

<!-- ralph:section IMPLEMENT_ROUTING -->
Follow the repository's CLAUDE.md / AGENTS.md conventions.

<!-- ralph:section VERIFY -->
Your local gate, in this order:

1. `npm test -- <paths>` for the areas you touched
2. `npm run typecheck`
3. `npm run build`

Never create an env file to get a gate past validation; a gate that fails on
environment is a finding to report.
