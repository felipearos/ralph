# Issue tracker

This repository's tickets live in GitHub issues on `felipearos/software-factory`. A spec
carries the `spec` label and never `ready-for-agent`; its tickets carry
`ready-for-agent`, which is what puts them on the loops' frontier.

## Native relationships

Every edge is written twice: as prose (`## Parent`, `## Blocked by`) for
people and tools that read the body, and as a native GitHub relationship for
the UI and anything that reads the frontier without parsing prose. Both
relationships address an issue by its REST `id`, not its number, so read it
first with `gh api repos/felipearos/software-factory/issues/<n> --jq .id`.

- **Parent / child.** A ticket is a sub-issue of its spec:
  `gh api -X POST repos/felipearos/software-factory/issues/<spec>/sub_issues -F sub_issue_id=<ticket id>`.
  An issue has at most one parent, so re-adding the same child is refused
  rather than duplicated. Remove one with
  `gh api -X DELETE repos/felipearos/software-factory/issues/<spec>/sub_issue -F sub_issue_id=<ticket id>`.
- **Blocked by.**
  `gh api -X POST repos/felipearos/software-factory/issues/<ticket>/dependencies/blocked_by -F issue_id=<blocker id>`.
  Adding an edge that already exists is refused, not duplicated. Remove a
  dropped edge with
  `gh api -X DELETE repos/felipearos/software-factory/issues/<ticket>/dependencies/blocked_by/<blocker id>`.

Both POSTs answer with the parent or target issue, not the one just linked, so
verify by re-reading:

```bash
gh api graphql -f query='{repository(owner:"felipearos",name:"ralph"){issue(number:<n>){parent{number} blockedBy(first:20){nodes{number}}}}}'
```
