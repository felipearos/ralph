// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const prompt = readFileSync(join(__dirname, 'prompt.md'), 'utf8');
const FRONTIER = 'selection="$(bun "$RALPH_HOME/frontier/next.ts" --take-one';

describe('restart recovery order', () => {
  it('inspects same-worktree state before any new ticket selection', () => {
    const localRecovery = prompt.indexOf('git status --short --branch');
    const frontierSelection = prompt.indexOf(FRONTIER);

    expect(localRecovery).toBeGreaterThan(-1);
    expect(prompt).toContain('git log --oneline "origin/$RALPH_BASE_BRANCH..HEAD"');
    expect(localRecovery).toBeLessThan(frontierSelection);
  });

  it('resumes this loop\'s existing claim before consulting the frontier', () => {
    const ownClaim = prompt.indexOf('tracker.ts" claimed');
    const frontierSelection = prompt.indexOf(FRONTIER);

    expect(ownClaim).toBeGreaterThan(-1);
    expect(ownClaim).toBeLessThan(frontierSelection);
    expect(prompt).toContain('Do not call the frontier');
    expect(prompt).toContain('skip this section and continue with §3');
  });

  it('protects local-only and uncommitted work from branch replacement', () => {
    expect(prompt).toContain('local commits, or uncommitted files');
    expect(prompt).toContain('Never reset, detach, clean, or overwrite recoverable work');
  });

  it('does not treat a clean merged ticket branch as unfinished work', () => {
    expect(prompt).toContain('clean obsolete ticket branch');
    expect(prompt).toContain('git switch --detach "origin/$RALPH_BASE_BRANCH"');
    expect(prompt).toContain('gh pr list --state merged --head');
    expect(prompt).toContain('If the done label is absent, resume step 7');
    expect(prompt.indexOf('{{PROJECT_PROMPT_ENQUEUE}}')).toBeLessThan(
      prompt.indexOf('Detaching only after the done label'),
    );
    expect(prompt.indexOf('"$RALPH_HOME/usage.py" --step "merged #<n>"')).toBeLessThan(
      prompt.indexOf('gh pr edit <pr> --add-label $RALPH_LOOP_NAME-done'),
    );
  });
});

describe('merging through the queue', () => {
  const enqueue = prompt.indexOf('{{PROJECT_PROMPT_ENQUEUE}}');
  const wait = prompt.indexOf('`<ralph>AWAIT_PR <pr> merge</ralph>`', enqueue);
  const merged = prompt.indexOf('--kind pr-merged');
  const cleanup = prompt.indexOf('7. Close the issue and mark the work as yours');

  it('never merges with gh — the queue is the merge path', () => {
    // The one mention left is the prohibition itself.
    expect(prompt.match(/gh pr merge/g)).toHaveLength(1);
    expect(prompt).toContain('**Never run `gh pr merge`**');
  });

  it('waits for MERGED between the enqueue and the post-merge cleanup', () => {
    // The enqueue command itself is project guidance (a Mergify comment for
    // Loggd), spliced in by the project fragment at exactly this point.
    expect(enqueue).toBeGreaterThan(-1);
    expect(wait).toBeGreaterThan(enqueue);
    expect(merged).toBeGreaterThan(wait);
    expect(cleanup).toBeGreaterThan(merged);
  });

  it('reads every non-zero exit of the wait as a finding, not a merge', () => {
    for (const outcome of ['dequeued', 'closed', 'timeout']) {
      expect(prompt.indexOf(`**${outcome}**`)).toBeGreaterThan(wait);
    }
    expect(prompt).toContain('Only once the outcome is `merged`');
  });

  it('no longer rebases a green PR merely for being behind', () => {
    expect(prompt).not.toContain('git rev-list --count "HEAD..origin/$RALPH_BASE_BRANCH"');
    expect(prompt).toMatch(/Rebase only for a real textual\s+conflict/);
  });

  it('resumes a PR a previous iteration already enqueued at the wait', () => {
    expect(prompt).toContain('If the PR already carries the `queued` label');
  });
});

describe('commands a project gate reads before they run', () => {
  // 2026-09-23: five orchestrator turns denied overnight. Three were one
  // compound command — record the review marker, push, write the body, `gh pr
  // create` — refused by the project's pre-PR gate, which judges the whole line
  // before any of it runs, so the marker the same line was about to write did
  // not exist yet. Two were enqueue comments the queue gate refused: one on a
  // PR the queue had already taken, one re-queueing a dequeued PR.
  const opened = prompt.indexOf('3. Push and `gh pr create`');
  const marker = prompt.indexOf('Record the review marker in a Bash call of its own', opened);

  it('records the review marker in its own call, before the one that opens the PR', () => {
    expect(opened).toBeGreaterThan(-1);
    expect(marker).toBeGreaterThan(opened);
    expect(prompt).toContain('judges the whole command before any part of it runs');
    expect(prompt.indexOf('`gh pr create` alone', marker)).toBeGreaterThan(marker);
  });

  // 2026-11-12, testo PR #3399: `{ …; } > merge-comment.md && gh pr comment
  // --body-file merge-comment.md` was refused as a body the guard could not
  // read, and three turns went on re-pathing the file. Every comment the
  // prompt posts from a file has the same timing trap as the review marker.
  it('writes every comment body file in a call before the one that posts it', () => {
    const rule = prompt.indexOf('**The same goes for every comment posted from a file**', marker);
    expect(rule).toBeGreaterThan(marker);
    const end = prompt.indexOf('\n\n', rule);
    expect(end).toBeGreaterThan(rule);
    const paragraph = prompt.slice(rule, end).replace(/\s+/g, ' ');
    for (const where of ['claim comment (§2)', 'review-thread reply (§5.6)', 'merge comment (§5.7)', 'stuck comment (§6)']) {
      expect(paragraph).toContain(where);
    }
    expect(paragraph).toContain('must already exist when the posting command is judged');
    expect(paragraph).toContain('not the path');
  });

  // The paragraph is the rule; these are the places a session reads when it
  // actually posts, so each one carries its own pointer back to it.
  it('points every comment-from-a-file step back at the own-call rule', () => {
    const flat = prompt.replace(/\s+/g, ' ');
    expect(flat).toContain('first, in a Bash call of its own, so the footer\'s newlines survive and the file exists when the post is judged; §5.3)');
    expect(flat).toContain('run the `reply:` command the tool printed, as two calls (§5.3)');
    expect(flat).toContain('writing its body file in a call before the one that posts it (§5.3)');
    expect(flat).toContain('the file written in a call of its own; §5.3), then push `ticket-blocked`');
  });

  it('never pushes past a gate with its override', () => {
    expect(prompt).toContain('**Never prefix a project gate\'s override**');
  });

  it('reads a refused enqueue of a PR the queue already took as the merge wait', () => {
    const enqueue = prompt.indexOf('{{PROJECT_PROMPT_ENQUEUE}}');
    const taken = prompt.indexOf('the queue already took it', enqueue);
    expect(taken).toBeGreaterThan(enqueue);
    expect(taken).toBeLessThan(prompt.indexOf('**dequeued**', enqueue));
  });

  it('re-queues an unreproducible dequeue once, with the project\'s re-queue command only', () => {
    const dequeued = prompt.indexOf('**dequeued**');
    const closed = prompt.indexOf('**closed**', dequeued);
    const requeue = prompt.indexOf('{{PROJECT_PROMPT_REQUEUE}}');
    expect(requeue).toBeGreaterThan(dequeued);
    expect(requeue).toBeLessThan(closed);
    expect(prompt).toMatch(/never re-run the enqueue command for it/);
    expect(prompt).toMatch(/If the project names no re-queue\s+command, do not re-queue/);
  });
});

describe('waiting is the supervisor\'s job', () => {
  const ci = prompt.indexOf('4. **Hand the CI wait to the supervisor');

  it('hands the CI wait back with AWAIT_PR after writing the handoff note', () => {
    expect(ci).toBeGreaterThan(-1);
    const note = prompt.indexOf('.ralph/logs/handoff-pr-<pr>.md', ci);
    const sigil = prompt.indexOf('`<ralph>AWAIT_PR <pr> ci</ralph>`', ci);
    expect(note).toBeGreaterThan(ci);
    expect(sigil).toBeGreaterThan(note);
  });

  it('keeps no in-session wait loop', () => {
    expect(prompt).not.toMatch(/sleep \d/);
    expect(prompt).not.toContain('merge-wait.ts');
    expect(prompt).toContain('**Never wait inside a session.**');
  });

  it('lists AWAIT_PR among the endings', () => {
    const endings = prompt.indexOf('End your output with exactly one of:');
    expect(prompt.indexOf('`<ralph>AWAIT_PR <pr> ci</ralph>`', endings)).toBeGreaterThan(endings);
  });

  it('names the hard token cap where the iteration reads code', () => {
    expect(prompt).toContain('**Your context is what this iteration costs.**');
    expect(prompt).toContain('`RALPH_ITERATION_TOKEN_CAP`');
  });
});

describe('a red check that does not reproduce', () => {
  it('is capped at one re-run and 15 minutes, then blocked', () => {
    expect(prompt).toContain('one re-run and 15\n   minutes');
    expect(prompt).toContain('Red again means\n   stuck, as in §6');
  });

  it('never counts a flake: a second flake red backs off instead of blocking', () => {
    expect(prompt).toContain('it never counts as a strike');
    expect(prompt).toContain('Do not re-run and\n     do not block');
    expect(prompt).toContain('`<ralph>RETRY_LATER</ralph>`. The supervisor waits with no model');
    expect(prompt).toContain("Only at the PR's fourth flake red");
    expect(prompt).toContain('the failure is not a flake as above');
  });
});

describe('problem and terminal-state pushes', () => {
  it.each(['pr-opened', 'pr-merged', 'gate-failure', 'ticket-blocked'])(
    'requires a %s push at the event boundary',
    (kind) => {
      expect(prompt).toContain(`--kind ${kind}`);
    },
  );

  it('makes a block say its kind on its first line, which the dashboard reads', () => {
    // block-reason.ts reads these leads; a reworded one would read as unknown.
    expect(prompt).toContain('starts `needs-migration:`, then names the draft PR and the\n  migration file');
    expect(prompt).toContain('Every other block starts `blocked:`');
    expect(prompt).toContain('`**Outcome: blocked\n(needs-migration).**`');
  });

  it('pushes a blocked ticket before clearing its claim', () => {
    expect(prompt.lastIndexOf('--kind ticket-blocked')).toBeLessThan(
      prompt.lastIndexOf('Clear the claim, mark it blocked'),
    );
  });
});

describe('parking a blocked ticket (#776)', () => {
  const stuck = prompt.slice(prompt.indexOf('If you got stuck'), prompt.indexOf('**Running out of §5.6 freshness rounds'));

  it('names only park-store.ts condition kinds', () => {
    const kinds = [...stuck.matchAll(/\{"kind":"([a-z-]+)"/g)].map((m) => m[1]);
    expect(new Set(kinds)).toEqual(new Set(['reference', 'check', 'step', 'label-removed']));
  });

  it('validates the condition before writing the file, and needs --pr for a check on the PR', () => {
    expect(stuck.indexOf('park-store.ts" check --condition')).toBeLessThan(stuck.indexOf('write `.ralph/logs/block-park.json`'));
    expect(stuck).toContain('`--pr` is required for `"on":"pr"`');
  });

  it('downgrades the push only with a checked condition, and keeps it high otherwise', () => {
    expect(stuck).toContain('Only if it exits 0, write `.ralph/logs/block-park.json` and push `normal`');
    expect(stuck).toContain('If the check refuses it, or you have no condition, write no file and push\n`high`');
    expect(stuck).toContain('--priority high --ticket <n>');
  });

  it('allows no condition at all, which blocks as before', () => {
    expect(stuck).toContain('"No condition I can name" is an allowed answer');
    expect(stuck).toContain('the ticket blocks exactly as it\nalways has');
  });

  it('writes the file before tracker.ts blocked reads it', () => {
    expect(stuck.indexOf('.ralph/logs/block-park.json')).toBeLessThan(stuck.indexOf('bun "$RALPH_HOME/tracker.ts" blocked <n>'));
    expect(stuck).toContain('It also reads `.ralph/logs/block-park.json`, records the park, and deletes the\nfile.');
  });
});

describe('journal publication', () => {
  it('drafts into the ignored logs and publishes through the harness publisher', () => {
    expect(prompt).toContain('draft=".ralph/logs/journal-draft-$(date -u +%Y%m%dT%H%M%SZ)-<n>-${sid:0:12}.md"');
    expect(prompt).toContain('bun "$RALPH_HOME/publish-journal.ts" --draft "$draft" --issue <n>');
    // The old flow's machinery is gone: no journal PR, no recovery branch.
    expect(prompt).not.toContain('journal-only PR');
    expect(prompt).not.toContain('recovery branch');
    expect(prompt).not.toContain('ralph/journal/');
  });

  it('reads every loop\'s journal through the reader, which follows journal.branch', () => {
    expect(prompt).toContain('bun "$RALPH_HOME/journal-read.ts" recent --count 8');
    // A hard-coded harness read would miss a project whose journal moved.
    expect(prompt).not.toContain('git -C "$RALPH_HOME" show "origin/main:$f"');
  });
});

describe('the harness is invoked from RALPH_HOME, never from a repo-relative ralph/', () => {
  it('names no in-repo harness path', () => {
    expect(prompt).not.toMatch(/(?<![.\w$])ralph\/(?:usage\.py|delegate\.sh|inspect\.sh|models\.json|push-notification\.ts|plan\.md|logs)/);
    expect(prompt).not.toContain('bun run next');
  });
});

describe('the spec axis reviews against the issue itself', () => {
  // Loop #1154: the spec reviewer had no `gh`, so it reviewed the brief's
  // paraphrase of the ticket and said so. The orchestrator fetches the issue
  // through the harness and names the file; the reviewer never needs `gh`.
  const gate = prompt.indexOf('1. **Review locally, on the two axes, before the PR.**');
  const fetch = prompt.indexOf('bun "$RALPH_HOME/issue-spec.ts" fetch <n>');
  const push = prompt.indexOf('3. Push and `gh pr create`');
  const inspector = readFileSync(join(__dirname, 'inspector.md'), 'utf8');

  it('fetches the issue into the logs as part of the review gate, before the PR', () => {
    expect(fetch).toBeGreaterThan(gate);
    expect(fetch).toBeLessThan(push);
    expect(prompt).toContain('Spec: .ralph/logs/spec-<n>.md');
  });

  it('never lets a paraphrase or a SPEC MISSING report stand in for the review', () => {
    expect(prompt).toContain('never paraphrase the issue in its place');
    expect(prompt).toContain('`SPEC MISSING`');
  });

  it('tells the reviewer to fail loudly rather than review a paraphrase', () => {
    expect(inspector).toContain('SPEC MISSING');
    expect(inspector).toContain('.ralph/logs/spec-<n>.md');
    expect(inspector).toContain("never review against the brief's paraphrase");
  });
});

describe('what the frontier is told to skip', () => {
  // 2026-09-22: ralph and rafa each excluded #1099–#1102 from the frontier
  // because old journal entries recorded two failed rescues — after the
  // operator had removed the blocked labels and said so on every ticket. The
  // gate, which reads labels and the plan and nothing else, kept naming #1099;
  // the iterations kept ending ALL_BLOCKED; ralph halted on the disagreement.
  const selection = prompt.slice(prompt.indexOf('4. **Take new work only'), prompt.indexOf('## 2. Claim'));

  it('passes only the plan\'s Out of scope list, never a journal-derived one', () => {
    expect(selection).not.toContain('recorded in the journal.');
    expect(selection).not.toContain('rescue-limit-number');
    expect(selection).toContain('--exclude <out-of-scope-number>');
  });

  it('names the blocked label as the rescue fence, and the operator\'s removal of it as the reset', () => {
    expect(selection).toContain('`$RALPH_LOOP_NAME-blocked`');
    expect(selection).toContain('Do **not** exclude tickets because the journal records failed attempts');
    expect(selection).toContain('has reset the count');
  });
});

describe('an external blocker', () => {
  it('has a sigil of its own, distinct from triage and from DONE', () => {
    expect(prompt).toContain('`<ralph>RETRY_LATER</ralph>` — ');
    const shepherd = prompt.slice(
      prompt.indexOf('1. **Shepherd this loop\'s pull request.**'),
      prompt.indexOf('2. **Resume this loop\'s unfinished claim.**'),
    );
    expect(shepherd).toContain('<ralph>RETRY_LATER</ralph>');
    expect(shepherd).toContain('do not end with `DONE`');
  });

  it('reaches the shipping half, where a dequeue from an outage is read', () => {
    const shipping = prompt.slice(prompt.indexOf('- **dequeued** (exit 2)'), prompt.indexOf('- **closed** (exit 3)'));
    expect(shipping).toContain('<ralph>RETRY_LATER</ralph>');
  });
});

describe('learnings', () => {
  it('reads both files at orientation, out of the harness origin/main, before any selection', () => {
    const read = prompt.indexOf('bun "$RALPH_HOME/learnings-read.ts" show');
    expect(read).toBeGreaterThan(-1);
    // In §0, before the frontier is asked for anything.
    expect(read).toBeLessThan(prompt.indexOf(FRONTIER));
    expect(prompt).toContain("this project's file and the harness's");
    expect(prompt).toContain('A missing file just means nothing');
  });

  it('makes the open entries binding while diagnosing, in §0 and again at a red check', () => {
    expect(prompt).toContain('**These are binding while you diagnose, not background.**');
    expect(prompt).toContain('follow that entry\'s\n   workaround and cite its slug in the journal');
    const red = prompt.slice(
      prompt.indexOf('**Check the open learnings from §0 against this failure first.**'),
      prompt.indexOf("bun \"$RALPH_HOME/bk-log.ts\" --pr <pr>"),
    );
    expect(red).toContain('its **Workaround** is the answer');
    // The check comes before the log read, which is before any re-run.
    expect(prompt.indexOf('**Check the open learnings from §0')).toBeLessThan(
      prompt.indexOf("**Read the failed job's log before you re-run"),
    );
  });

  it('writes one only for a systemic cause, on an ending that was not a merge', () => {
    const write = prompt.slice(
      prompt.indexOf('### Write a learning, when the cause was systemic'),
      prompt.indexOf('If you got stuck (2nd failed rescue'),
    );
    expect(write).toContain('**blocked, parked, `RETRY_LATER` or stuck**');
    expect(write).toContain('**systemic**');
    expect(write).toContain('Rework\non this ticket alone');
    expect(write).toContain('this is not a\nsecond journal');
  });

  it('fixes the entry shape, the slug and the scope rule', () => {
    const write = prompt.slice(
      prompt.indexOf('### Write a learning, when the cause was systemic'),
      prompt.indexOf('If you got stuck (2nd failed rescue'),
    );
    expect(write).toContain('<!-- learning: opencode-subscription-lapsed -->');
    expect(write).toContain('- **Seen:**');
    expect(write).toContain('- **Workaround:**');
    expect(write).toContain('- **Fix:**');
    expect(write).toContain('--learning "$draft" --scope project');
    expect(write).toContain('`--scope harness` when the fix belongs in Ralph');
    expect(write).toContain('`learnings/README.md` owns');
    // The draft name the publisher's regex requires.
    expect(write).toContain('.ralph/logs/learning-draft-$(date -u +%Y%m%dT%H%M%SZ)-$slug.md');
    // A repeat is reported, not assumed.
    expect(write).toContain('reuse the slug of an entry that already says this');
    expect(write).toContain('`learning seen-again:`');
  });

  it('corrects a stale open entry with --revise rather than --close or a hand edit', () => {
    const write = prompt.slice(
      prompt.indexOf('### Write a learning, when the cause was systemic'),
      prompt.indexOf('If you got stuck (2nd failed rescue'),
    );
    expect(write).toContain('--revise "$draft" --scope harness');
    // Its own draft name, since a wrong one is a refusal in the finish phase.
    expect(write).toContain('.ralph/logs/learning-draft-$(date -u +%Y%m%dT%H%M%SZ)-$slug.md');
    // Why it is not --close: the entry's Fix has not landed.
    expect(write).toContain('corrected, not closed');
    expect(write).toContain('published state');
    expect(write).toContain('`learning revised:`');
    // The draft is a whole block, not three bare lines: `blockOf` refuses a
    // draft with no '### ' heading, so the wording decides whether the verb
    // works at all.
    expect(write).toContain('the `### ` heading, the slug');
    expect(write).toContain("keeping its heading's original date");
    // The revise must come after the entry shape it reuses, so a loop reads the
    // three lines before it is told how to replace them.
    expect(write.indexOf('--revise "$draft"')).toBeGreaterThan(write.indexOf('--learning "$draft"'));
  });

  it('retires an entry in the finish phase, after the done label and only on a real fix', () => {
    const close = prompt.indexOf('--close <slug> --pr <pr> --scope project|harness');
    expect(close).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(prompt.indexOf('gh pr edit <pr> --add-label $RALPH_LOOP_NAME-done'));
    expect(prompt).toContain('when one names this ticket in its **Fix** line');
    expect(prompt).toContain('never close one on a PR\n    that only worked around the problem');
  });
});

// On 2026-10-29 acme-pwa's default branch was a stale `main` while its base
// was `dev`; a bare `gh pr create` opens against the default branch, so the
// step that opens the PR must name the base itself.
describe('opening the PR', () => {
  it('passes the base branch to gh pr create', () => {
    const opened = prompt.indexOf('3. Push and `gh pr create`');
    expect(opened).toBeGreaterThan(-1);
    expect(prompt.slice(opened, opened + 200)).toContain('`--base "$RALPH_BASE_BRANCH"`');
  });

  it('passes the base branch in the ci-doctor prompt too', () => {
    const doctor = readFileSync(join(__dirname, 'prompts', 'ci-doctor.md'), 'utf8');
    const opened = doctor.indexOf('3. Push and `gh pr create`');
    expect(opened).toBeGreaterThan(-1);
    expect(doctor.slice(opened, opened + 200)).toContain('`--base "$RALPH_BASE_BRANCH"`');
  });
});
