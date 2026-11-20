# Ralph journals

One file per iteration. Nothing here is ever edited after it is written, and
no two iterations ever write to the same file — which is the whole point:
journaling must not be able to produce a merge conflict, however many loops
run at once.

## Naming

```
<journal.dir>/<UTC timestamp>-<issue>-<session>.md      e.g. journal/loggd/
              20260819T143205Z  -582  -a1b2c3d4e5f6
```

`journal.dir` comes from the project's `.ralph/config.json`; each project gets
its own directory in this (the harness) repository — unless its config also
names `journal.branch`, which moves its entries onto that branch of the
project's own repository (see the main README, "A journal in the project's
repository").

## Publishing

The iteration writes its entry as a draft inside the project worktree,
`.ralph/logs/journal-draft-<UTC timestamp>-<issue>-<session>.md`, and hands it to
the publisher:

```bash
bun "$RALPH_HOME/publish-journal.ts" --draft "$draft" --issue <n|none>
```

The publisher serialises every loop on the machine behind one lock
(`~/.ralph/journal.lock`), works in a harness-owned worktree of this repository
(`~/.ralph/journal-wt`) detached at `origin/main`, commits exactly the one entry
as `chore(<loop>): journal <project> #<n>`, pushes it to `main` (retrying a
rejected push up to five times on a fresh `origin/main`), and deletes the draft.
It never touches the project checkout's git state. A failed publish leaves the
draft in place.

- **timestamp** — `date -u +%Y%m%dT%H%M%SZ`, taken when the entry is written.
  Leading position means plain filename order is chronological order, so the
  newest entries are the last ones a `sort` prints.
- **issue** — the ticket number worked, or `none` when the iteration picked
  nothing (an `ALL_BLOCKED` orientation still journals why).
- **session** — the first 12 characters of `$RALPH_SESSION_ID`, the uuid
  `ralph.sh` mints per iteration. This is the part that separates two loops
  that start the same second on the same issue: no two iterations share a
  session uuid, so the only way to collide is for two of them to share their
  first 12 hex characters — 48 bits — within the same second.

## Entry template

`status.sh` summarises the journal by reading the first `#` heading and the
`**Outcome:**` line, so keep both. Everything after them is free-form.

```markdown
# 2026-08-19 — #582 Journal: one file per iteration

**Outcome: merged.** PR #592, squash-merged, issue auto-closed.

**Key decisions.** …why it was built this way, and what was ruled out.

**Files touched.** …

**For the next iteration.** …what to skip, what is still open, any dead end
found here so nobody walks into it again.

<plain-text token summary from `"$RALPH_HOME/usage.py" --step journal`>
```

## Reading

Orientation reads the newest entries **across every loop**, not just its own —
the value of the journal is that an iteration can skip a dead end some other
iteration already found, and that has to keep working when the other iteration
belonged to a different loop. Read them out of `origin/main` rather than the
working tree, which is one loop's view and goes stale the moment another loop
pushes:

```bash
git -C "$RALPH_HOME" fetch --quiet origin main
git -C "$RALPH_HOME" ls-tree --name-only origin/main "$RALPH_JOURNAL_DIR/" | grep -E '/20' |
  sort | tail -n 8 |
  while read -r f; do printf '\n=== %s\n' "$f"; git -C "$RALPH_HOME" show "origin/main:$f"; done
```

## Archive

`loggd/progress.md` is Loggd's single append-only journal this directory replaced. It
is kept for the history written in it and is **never appended to again**.
