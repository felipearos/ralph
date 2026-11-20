# Ralph learnings

Operational lessons from running Ralph, each with its status. Remove an entry
once it's fixed and deployed, and link the PR that fixed it.

Learnings are split the way journals are, by where the fix belongs:

| File | Holds |
| --- | --- |
| `harness.md` | Lessons about Ralph itself (supervisor, loops, roles, dashboard, onboarding). They apply to every project, so the fix goes in this repository, even when one project exposed the problem. |
| `<project>.md` | Lessons about one project: its CI, its tests, its host, and what happens when Ralph runs on it. The fix goes in that project, or in its `.ralph/` config. The file name matches the project's `journal.dir` (`journal/<project>`). With `journal.branch` set, it lives on that branch of the project's repository instead. |

When a project lesson turns out to be general, move it to `harness.md` and
keep a one-line pointer in the project file.

## How loops use them (#201)

**Reading.** Every iteration's `select` phase prints the `## Open` section of
both files at orientation, out of this repository's `origin/main`:

```bash
bun "$RALPH_HOME/learnings-read.ts" show
```

`origin/main` because that is where every loop publishes, so it is the only ref
that holds what the OTHER loops learned. Each file is capped
(`RALPH_LEARNINGS_CAP_BYTES`, 8 KB by default), newest entries kept, and a line
NAMES the ones it left out, so the cap hides an entry's detail but never that
the entry exists. A missing file just means nothing has been learned yet — and
a harness checkout that cannot be read says so, rather than claiming the list
is empty. The open entries are binding while a loop diagnoses a failure: when one
matches, it follows that entry's **Workaround** and cites the slug rather than
investigating again.

**Writing.** A loop writes an entry only when an iteration ends blocked,
parked, `RETRY_LATER` or stuck AND the cause was **systemic** — it will hit
other tickets. Rework on one ticket is what the journal is for.

```bash
bun "$RALPH_HOME/publish-journal.ts" --learning <draft> --scope project|harness
bun "$RALPH_HOME/publish-journal.ts" --revise <draft> --scope project|harness
bun "$RALPH_HOME/publish-journal.ts" --close <slug> --pr <n> --scope project|harness
```

Every one of them commits as `chore(<loop>): learning <label> <slug>`, so the
git log says which entry was touched but not which of the four things happened
to it — read the printed outcome (`added`, `seen-again`, `revised`, `closed`),
or the commit's diff.

A new `--scope project` entry whose `Change` line names harness code
(`ralph.sh`, `pr-wait.ts`, `frontier/`, …) and would file a fix ticket is
refused, draft kept: that ticket would land in the project's repo, where no
loop can fix the harness, so publish it with `--scope harness` (#815). A
sighting or revision of an entry already in the project file still publishes,
but files no ticket and says so on stderr.

Same lock, worktree and retry as the journal. Unlike a journal entry, these
files are shared, so every attempt re-reads the file from a fresh `origin/main`
and redoes the edit there; two loops publishing at once both land.

## Entry shape

Each open entry is a `### <title>` block carrying a stable slug and three
lines. The slug is the key, so keep it stable:

```markdown
### The executor's runner refuses every call (2026-10-06)
<!-- learning: opencode-subscription-lapsed -->
- **Seen:** evidence — the PR, build or run, and the date.
- **Workaround:** what to do instead.
- **Fix:** the issue that would end it, or "no issue yet".
- **Change:** the bounded code change (optional until it is understood).
- **Verify:** the reproducible verification criterion (optional until it is understood).
```

One `###` block per entry, with no unfenced `## ` or `### ` inside its body —
that would be a section or an entry rather than prose, and the publisher
refuses it. A quoted heading has to be fenced.

Publishing a slug that is already open appends a dated `- **Seen again:**` line
to that entry instead of duplicating it, and reports `learning seen-again:`.
`--close` moves the entry into the `## Fixed` table as one row.

A **Fix** that starts with `no issue yet` (alone, or followed by what the fix
would be) is now promoted automatically to a deduplicated GitHub ticket when it
is published. **Change** and **Verify** make it ready for a
coder; otherwise it goes to triage. The resulting ticket URL is written at the
head of **Fix**, and the text after the placeholder is kept after it. Reconciliation at startup and orientation retries pending entries
after GitHub failures. `RALPH_FINDINGS_DISABLED=1` disables filing while keeping
learning publication. An operator can file any entry without a ticket at once,
from the dashboard's **File ticket** or `findings.ts file <slug> --scope …`.
See the repository README for the workflow and limits.

`--revise` is for the third thing that happens to an entry: its **Workaround**
or **Seen** has gone stale — it names a hold that was lifted or a ticket that
has merged — while the problem it describes is still open. It takes a draft of
the whole block under the entry's own slug, replaces it where it sits, stays
under `## Open`, and reports `learning revised:`. Keep the heading's original
date: a correction is not a new sighting, which is also why it appends no
`Seen again` line. The lines already there are carried over, so a draft need
not reproduce them; a `Seen again` line in a draft is ignored either way, and a
genuine new sighting is `--learning` with the same slug, not a revise. The slug
must already be open; an unknown one is refused rather than added, so a typo
cannot file a near-duplicate, and a draft that only repeats what the file says
reports
`learning already revised:` and commits nothing. This is the only way to
correct one of these files: they are published state, so a hand edit in a
ticket branch is not a correction but a second copy (#307).

One field a revise will not move backwards: when the entry's **Fix** already
names a ticket and the draft's still says `no issue yet`, the ticket is kept.
A revise is drafted from a snapshot, and a placeholder written over a link
made seconds earlier is how one learning got two fix tickets (#486). A draft
naming a different ticket still replaces it; putting `no issue yet` back is
an operator's edit of the file on `main`, never a loop's.

The entries written before #201 carry no slug. They still read fine; the first
publish that touches one can give it a slug.

**Where the files live.** `learnings.file` in the project's
`.ralph/config.json`, a path inside THIS repository, defaulting to
`learnings/<basename of journal.dir>.md`. A project opts out with
`"learnings": false`.
