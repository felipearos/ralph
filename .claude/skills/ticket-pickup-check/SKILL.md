---
name: ticket-pickup-check
description: Check whether a loop will pick up a given issue of a Ralph project, and if not, say exactly why. Use when someone asks "will the loops take #N?", "why is nobody working on #N?", after filing or editing a ticket meant for the loops, or before labelling one ready-for-agent. Read-only - it never labels, comments or claims.
license: MIT
compatibility: Needs bun, jq and an authenticated gh, run from a checkout of a Ralph project (one with .ralph/config.json).
metadata:
  project: software-factory
---

# Ticket pickup check

A loop takes work only through the frontier (`frontier/next.ts --take-one`).
A ticket that looks fine to a person can still be skipped: a missing label, a
blocker that is still open, a `## Parent` the frontier reads as a different
issue, a fence in `.ralph/plan.md`, a staffing-group collision, or a sibling
loop already holding it. This check asks the frontier itself, read-only, and
explains the answer from the ticket's own body and labels.

## Inputs

- **Issue number** `N` (required). If the user gave none, or gave a URL from a
  different repository than `.ralph/config.json`'s `repo`, stop and ask.
- **Project checkout**: the current directory must contain `.ralph/config.json`.
  If it does not, stop and ask which project checkout to run from.
- **Harness**: `RALPH_HOME` if set, else `~/ralph`, else this checkout when it
  is the harness repository itself (it has `frontier/next.ts`). Use the first
  that has `frontier/next.ts` and `tracker.ts`; if none has, stop and ask.

## Never

- Never run `frontier/next.ts` without `--dry-run`. Without it the tool
  assigns every READY NOW ticket to the project owner, and the loops then
  treat those tickets as taken by a human and skip them.
- Never use `--take-one`: that is a loop's claim, and it labels the ticket.
- Never call `gh issue`. Issue reads go through `tracker.ts` (house rule 2),
  so the same check works on GitHub, Linear and Jira projects.
- Never change the ticket. Report what should change; the person decides.

## Steps

Set these once, in one shell:

```bash
N=<issue number>
H="${RALPH_HOME:-$HOME/ralph}"; [ -f "$H/frontier/next.ts" ] || H="$PWD"
OUT="${TMPDIR:-/tmp}/ticket-pickup-check-$N"; mkdir -p "$OUT"
```

1. **Read the ticket through the tracker.**

   ```bash
   bun "$H/tracker.ts" view "$N" --json > "$OUT/issue.json"; echo "exit $?"
   jq '{number,title,state,labels,assignees,pullRequests}' "$OUT/issue.json"
   ```

   Exit 69: the tracker is not connected for this project - stop and report
   that. Exit 75: throttled - stop, report it, and suggest a retry later.
   Any other non-zero exit, or an issue whose `number` is not `N`: stop.
   A closed issue is never picked: report that and stop.

2. **Read the body the way the frontier does.** Print the sections:

   ```bash
   jq -r .body "$OUT/issue.json" > "$OUT/body.md"
   grep -nE '^## ' "$OUT/body.md"
   ```

   Check, and note each problem with its line:
   - `## What to build` and `## Acceptance criteria` exist; the criteria are
     `- [ ]` checkboxes. More than 8 criteria puts the ticket in the
     triager's Oversize bucket.
   - `## Blocked by` and `## Parent`: on GitHub the frontier reads every
     `#<n>` under them as an issue of THIS repository - including the number
     in `owner/other-repo#<n>`. So look up the NUMBER the frontier reads,
     never the `owner/repo#<n>` text (the tracker takes a bare number only):

     ```bash
     for ref in <each n>; do printf '#%s ' "$ref"; bun "$H/tracker.ts" view "$ref" --json 2>/dev/null | jq -c '{state, title}' || echo "does not exist here"; done
     ```

     Report every reference written as `owner/repo#<n>` and every number
     that does not exist here. Say what it does to the frontier: a missing
     `## Blocked by` issue is not in its census, so it blocks NOTHING - the
     ticket can be offered with that dependency unmet; a missing `## Parent`
     becomes a phantom spec (step 4 shows it as `spec` with `title: null`).
     In `issue.json`, `labels` is a list of plain strings, not objects.
   - `## Staffing group`, if present, must be the LAST section's single value
     with no footer after it; a "Generated with" line inside it has made the
     whole frontier throw before.

3. **Read the labels and fences.**
   - `ready-for-agent` must be present. `spec` means it is a container: it is
     never picked itself, only its children.
   - Any `<loop>-wip` means a loop holds it now; `<loop>-blocked` means a loop
     parked it (the triager may rescue it after 7 days); `ready-for-human`
     means it waits on a person.
   - An assignee reads as "a human has this": loops skip assigned tickets.
   - Difficulty routing: `bun "$H/jav.ts" --json | jq '.config | {enabled, labels}'`.
     If `enabled` is true, the ticket needs one of `labels` (unless it carries
     `priority:urgent` or `ci-health`), or no loop is offered it.
   - Scope fence: `git fetch -q origin && git show "origin/$(jq -r '.baseBranch // "main"' .ralph/config.json):$(jq -r '.plan // ".ralph/plan.md"' .ralph/config.json)" | grep -n "#$N\b"`.
     A hit under `## Out of scope` means no loop will ever take it.

4. **Ask the frontier, read-only.**

   ```bash
   bun "$H/frontier/next.ts" --dry-run --json > "$OUT/frontier.json" 2> "$OUT/frontier.err"; echo "exit $?"
   jq -c --argjson n "$N" '[paths(objects and .number? == $n)] | map(.[0]) | unique' "$OUT/frontier.json"
   jq -c --argjson n "$N" '[.tree[] | .. | objects | select(.number? == $n and has("state")) | {state, detail, stuck, human, otherBlockers, heldBy}]' "$OUT/frontier.json"
   jq -c --argjson n "$N" '.ready[] | select(any(.tickets[]; .number == $n)) | {spec: .spec.number, staffingGroup}' "$OUT/frontier.json"
   jq -c --argjson n "$N" '.tree[] | select(any(.. | objects; .number? == $n)) | .spec' "$OUT/frontier.json"
   ```

   The last line is the spec the frontier files the ticket under; a `title`
   of `null` there means its `## Parent` names no issue of this repository.

   Exit 75: throttled - stop and report. Another non-zero exit, or output
   that is not JSON: stop, and quote the first lines of `frontier.err`.
   Read the sections the ticket appears in:

   | Section | Meaning |
   | --- | --- |
   | `ready` (in `.tickets`) | a free loop takes it next, one per staffing group |
   | `ready` (as `.spec` only) | it is a spec header; its child is the work |
   | `occupied` | ready, but its staffing group already has a ticket in work |
   | `inFlight` | a loop has it, or a PR carries it (`detail`) |
   | `blocked` | waits on the blockers listed |
   | `stuck` | parked; `stuckReasons` says why |
   | `malformed` | the frontier cannot read its body |
   | `untriaged` | ready, but carries no difficulty label while routing is on |
   | `human` | waits on a person (`reason`) |
   | `tree` only, state `open` | not offered: usually no `ready-for-agent` |

   Also check `.stuckReasons` and `frontier.err` for lines naming `#N`.

5. **Cross-check.** The frontier's answer must agree with steps 2-3. If the
   frontier offers the ticket while step 2 found a problem (for example a
   `## Blocked by` reference to another repository that it silently read as a
   local issue), report both: the frontier's verdict is what the loops will
   do, the problem is what the person should fix.

## Result

Write `$OUT/report.md` and print it:

```
Ticket #N: <title>
Verdict: PICKED NEXT | WAITING (<on what>) | NEVER PICKED (<why>) | HELD (<by whom>)
Frontier: sections [...], state <state>, detail <detail>
Body: <one line per problem found in step 2, with the line number, or "no problems">
Labels and fences: <one line per finding from step 3>
To make it pickable: <the smallest change, or "nothing - it is next">
Evidence: $OUT/issue.json, $OUT/frontier.json, $OUT/report.md
```

The check is complete only when step 4 ran and the verdict cites the frontier
sections it came from. A verdict from reading the body alone is incomplete:
say so and why.
