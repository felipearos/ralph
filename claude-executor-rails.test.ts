// @vitest-environment node
/**
 * The claude executor's Bash rails (`claude-executor-settings.json`) refuse
 * what they are for and nothing that is merely nearby.
 *
 * Between 2026-09-26 and 2026-09-28 the claude executors of all four loops
 * logged 29 `permission-denied` runner failures, and each one paged the
 * operator. Twelve were commands no rule meant to refuse: an executor
 * appended `git stash list` (a read) to a test run, grepped for
 * `publishedReviewPredicate`, or read `playwright.config.ts`, and the broad
 * `git stash *`, `*publish*` and `*playwright*` tripwires caught the whole
 * line. The rest were meant: `pkill -f` by pattern on a host every loop
 * shares, and `git checkout -- <file>`. Every command below is one of those
 * logged commands, trimmed, with the loop and ticket it came from.
 *
 * This file cannot run Claude Code's matcher, so it models it: a command is
 * split into its subcommands at `;`, `&&`, `||`, `|` and newlines (heredoc
 * bodies are data, not commands), file redirections are dropped the way the
 * harness drops them before it reports a denial, and a rule is matched
 * against every subcommand and against the whole line. A rule's `*` is any
 * text; a trailing ` *` or `:*` also matches the bare prefix. The model errs
 * toward denying. `claude-executor-rails-probe.sh` asks the live CLI the same
 * questions for the cases that matter most.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const HOME = dirname(new URL(import.meta.url).pathname);
const settings = JSON.parse(readFileSync(join(HOME, "claude-executor-settings.json"), "utf8")) as {
  permissions: { deny: string[] };
};

const bashRules = settings.permissions.deny
  .filter((rule) => rule.startsWith("Bash(") && rule.endsWith(")"))
  .map((rule) => rule.slice("Bash(".length, -1));

const escape = (text: string): string => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

/** One rule's pattern as a whole-string regex. */
function ruleRegex(pattern: string): RegExp {
  if (pattern.endsWith(":*")) return new RegExp(`^${escape(pattern.slice(0, -2))}(\\s.*)?$`, "s");
  const trailing = pattern.endsWith(" *");
  const body = trailing ? pattern.slice(0, -2) : pattern;
  const source = body.split("*").map(escape).join(".*");
  return new RegExp(`^${source}${trailing ? "(\\s.*)?" : ""}$`, "s");
}

type Rule = { pattern: string; regex: RegExp };
const bashRulesOf = (deny: readonly string[]): Rule[] =>
  deny
    .filter((rule) => rule.startsWith("Bash(") && rule.endsWith(")"))
    .map((rule) => rule.slice("Bash(".length, -1))
    .map((pattern) => ({ pattern, regex: ruleRegex(pattern) }));

const rules = bashRules.map((pattern) => ({ pattern, regex: ruleRegex(pattern) }));

/** Split a command line into subcommands, quote- and heredoc-aware. */
function subcommands(command: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;
  const heredocs: string[] = [];
  const lines = command.split("\n");
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]!;
    if (heredocs.length > 0) {
      if (line.trim() === heredocs[0]) heredocs.shift();
      continue;
    }
    for (const match of line.matchAll(/<<-?\s*['"]?(\w+)['"]?/g)) heredocs.push(match[1]!);
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (quote) {
        current += ch;
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"') {
        quote = ch;
        current += ch;
        continue;
      }
      const two = line.slice(i, i + 2);
      if (two === "&&" || two === "||") {
        out.push(current);
        current = "";
        i++;
        continue;
      }
      // `2>&1` and `&>` are redirections, not a separator.
      if (ch === "&" && (line[i - 1] === ">" || line[i + 1] === ">")) {
        current += ch;
        continue;
      }
      if (ch === ";" || ch === "|" || ch === "&") {
        out.push(current);
        current = "";
        continue;
      }
      current += ch;
    }
    if (!quote) {
      out.push(current);
      current = "";
    } else {
      current += "\n";
    }
  }
  out.push(current);
  return out.map(normalise).filter((part) => part.length > 0);
}

/** Drop file redirections (`>/dev/null`, `2> /tmp/x`), keep `2>&1`; squeeze spaces. */
function normalise(part: string): string {
  return part
    .replace(/(^|\s)(\d?>>?|&>)\s*(?!&)("[^"]*"|'[^']*'|[^\s;&|]+)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The rules that deny `command`, in the model above. */
function denyingRules(command: string, from: readonly Rule[] = rules): string[] {
  const candidates = [normalise(command), ...subcommands(command)];
  return from.filter(({ regex }) => candidates.some((part) => regex.test(part))).map(({ pattern }) => pattern);
}

describe("the matcher model", () => {
  it("reads the rules the way the file documents them", () => {
    expect(denyingRules("git push origin HEAD")).toContain("git push *");
    expect(denyingRules("git push")).toContain("git push:*");
    expect(denyingRules("echo ok && gh pr list")).toContain("gh *");
    expect(denyingRules("echo db:migrate")).toContain("*db:migrate*");
    expect(denyingRules("ls -la")).toEqual([]);
  });

  it("treats a heredoc body as data and a redirection as no command", () => {
    expect(denyingRules("python3 - <<'EOF'\nprint('git push')\nEOF\ngit diff --stat").filter((r) => r.startsWith("git push"))).toEqual([]);
    expect(subcommands("git stash list >/dev/null; ls .prettierrc* 2>/dev/null")).toEqual(["git stash list", "ls .prettierrc*"]);
    expect(subcommands("bunx jest a.test.ts 2>&1 | tail -5")).toEqual(["bunx jest a.test.ts 2>&1", "tail -5"]);
  });
});

/** Logged commands the rails refused although no rule meant them: now allowed. */
const HARMLESS: Array<[source: string, command: string]> = [
  [
    "ralph #1539",
    'bunx jest hooks/__tests__/title-detail-query.test.tsx hooks/__tests__/library-write.test.ts 2>&1 | grep -E "FAIL|PASS|✕|Tests:"; git stash list | head -0; git diff --stat',
  ],
  [
    "remo #1567",
    'timeout 300 bunx jest --no-watchman __tests__/manage-list.test.tsx 2>&1 | grep -E "^\\s+(●|Expected|Received|Number of calls)" | head -80; git stash list | head -0',
  ],
  [
    "remo #1567",
    "git stash list >/dev/null; ls ../.prettierrc* .prettierrc* 2>/dev/null; timeout 60 bunx prettier --check __tests__/create-list.test.tsx components/__tests__/ListCard.test.tsx 2>&1 | tail -12",
  ],
  [
    "remo #1483",
    "cd /home/faros/orca/workspaces/loggd/remo-loop/mobile; bunx eslint hooks/library-write.ts hooks/useMediaActions.ts 2>&1 | tail -15; cd ..; grep -rn '\"viewer-media-state\"' mobile/hooks mobile/lib --include='*.ts' | grep -v __tests__; git stash list | head -0; git diff --stat",
  ],
  [
    "remo #1371",
    "cd /home/faros/orca/workspaces/loggd/remo-loop/mobile; date +%s; bun run typecheck 2>&1 | tail -15; git stash list | head -0; git diff --stat",
  ],
  [
    "ralph #1480",
    'cd /home/faros/orca/workspaces/loggd/ralph-loop; grep -rln "publishedReviewPredicate" src --include=*.test.ts | grep -i conform',
  ],
  [
    "remo #1567",
    'cd /home/faros/orca/workspaces/loggd/remo-loop/mobile; grep -A40 "● ManageListScreen › stale edit review › publishes the chosen" /tmp/ml2.log | cut -c1-220 | head -45',
  ],
  [
    "ralph #1525",
    'git stash list >/dev/null; git show HEAD:"mobile/app/(tabs)/index.tsx" > /tmp/orig-idx.tsx && cp /tmp/orig-idx.tsx "app/(tabs)/_orig_check.tsx" && bunx eslint "app/(tabs)/_orig_check.tsx" 2>&1 | tail -4; rm "app/(tabs)/_orig_check.tsx"',
  ],
  [
    "ralph #1415",
    "cd /home/faros/orca/workspaces/loggd/ralph-loop && ls -a | grep -i prettier; grep -n '\"prettier\"' -A3 package.json | head; cd mobile && git stash list >/dev/null; for f in $(cat /tmp/files1415); do git show HEAD:mobile/$f | ../node_modules/.bin/prettier --stdin-filepath $f --check >/dev/null 2>&1 && echo \"clean-before $f\"; done",
  ],
  [
    "ralph #1410",
    "cd /home/faros/orca/workspaces/loggd/ralph-loop/mobile; git stash list >/dev/null; cp \"app/show/[id]/index.tsx\" /tmp/idx.bak; python3 - <<'EOF'\np='app/show/[id]/index.tsx'\ns=open(p).read()\ns='import { showCastPreview } from \"@/lib/show-credits\";\\n'+s\nopen(p,'w').write(s)\nEOF\nbunx jest __tests__/show-detail-trimmed-credits.test.tsx 2>&1 | grep -E \"✓|✕|Tests:\"; cp /tmp/idx.bak \"app/show/[id]/index.tsx\"; git diff --stat",
  ],
  [
    "ralph #1414",
    "cd /home/faros/orca/workspaces/loggd/ralph-loop/mobile; python3 - <<'EOF'\np='__tests__/useFeedSection.test.tsx'\ns=open(p).read()\ns=s.replace('      path,\\n','')\nopen(p,'w').write(s)\nEOF\nbunx jest __tests__/useFeedSection.test.tsx 2>&1 | tail -5; git stash list | head -0; date +%s",
  ],
  [
    "rafa #1370",
    "cd /home/faros/orca/workspaces/loggd/rafa-loop; grep -n \"Search & Discovery\\|openSearchDialog\\|^import\" e2e/search.spec.ts | head -30; grep -n \"viewport\\|devices\" playwright.config.ts | head",
  ],
  // Harmless shapes that were never refused, held here so a later tripwire
  // does not start refusing them.
  ["read-only git", "git show HEAD:mobile/app/_layout.tsx | head -40; git log --oneline -5; git diff --stat; git stash show -p stash@{0}"],
  ["scratch output", "cat /tmp/claude-1000/-home-faros-orca-workspaces-loggd-remo-loop/9fa8/tasks/bhbzwvxyx.output | tail -40"],
  ["in-place edit", "sed -i '90s/filter: \"all\"/filter: \"shows\"/' src/lib/api-utils.ts; git diff --stat src/lib"],
  ["imports", "grep -rn \"@playwright/test\" e2e | head -3"],
];

/** Logged commands the rails refused on purpose, and the rest of each family: still denied. */
const DELIBERATE: Array<[source: string, command: string, rule: RegExp]> = [
  // `pkill -f` by pattern: every loop shares the host and runs the same jest
  // commands, so a pattern kill reaches another loop's run.
  ["rafa #1394", 'pkill -f "jest __tests__/onboarding-flow" ; timeout 100 bunx jest __tests__/onboarding-flow.test.tsx > /tmp/rafa-jest.txt 2>&1; echo exit $?', /^pkill/],
  ["ralph #1573", 'cd /home/faros/orca/workspaces/loggd/ralph-loop/mobile; pkill -f "jest --no-watchman hooks/__tests__/useFeedMuteAction" ; date +%s', /^pkill/],
  ["remo #1395", 'cat /tmp/claude-1000/x/tasks/bhbzwvxyx.output | tail -40; pkill -f "detectOpenHandles" ; date +%s', /^pkill/],
  ["rafa #1403", 'pkill -f "jest.*activity-neighbour-pages" ; cp /tmp/activity.new.tsx "app/(tabs)/activity.tsx" && git status --short', /^pkill/],
  // `git checkout -- <file>` rewrites the working tree the orchestrator reviews.
  ["ralph #1475", "sed -i '90s/filter: \"all\"/filter: \"shows\"/' src/lib/api-utils.ts; bun run test src/app/api/v1/users/reviews/route.test.ts 2>&1 | grep -E \"✓|×\"; git checkout -- src/lib/api-utils.ts 2>/dev/null || git restore src/lib/api-utils.ts", /^git checkout/],
  ["ralph #1409", "bun run test src/server/auth/acting-member.bearer-local.test.ts 2>&1 | head -20; git checkout -- src/server/auth/acting-member.ts; git status --short", /^git checkout/],
  // Every stash that moves work: only `list` and `show` are reads.
  ["stash", "git stash", /^git stash/],
  ["stash", "git stash >/dev/null && bunx jest a.test.ts", /^git stash/],
  ["stash", "git stash 2>&1 | tail -1", /^git stash/],
  ["stash", "git stash -u", /^git stash/],
  ["stash", "git stash --include-untracked -m wip", /^git stash/],
  ["stash", "git stash push -m wip", /^git stash/],
  ["stash", "git stash save wip", /^git stash/],
  ["stash", "git stash pop", /^git stash/],
  ["stash", "cd mobile && git stash apply stash@{0}", /^git stash/],
  ["stash", "git stash drop", /^git stash/],
  ["stash", "git stash clear", /^git stash/],
  ["stash", "git stash branch scratch", /^git stash/],
  // Package publishing, and the harness's journal publisher.
  ["publish", "npm publish", /publish/],
  ["publish", "bun publish --dry-run", /publish/],
  ["publish", "bunx changeset publish", /publish/],
  ["publish", 'bun "$RALPH_HOME/publish-journal.ts" --draft d.md --issue 1', /publish/],
  // E2E belongs to CI.
  ["e2e", "bunx playwright test e2e/search.spec.ts", /playwright/],
  ["e2e", "npx playwright install chromium", /playwright/],
  ["e2e", "bunx playwright@1.58 test", /playwright/],
  ["e2e", "cd .. && npx playwright", /playwright/],
  ["e2e", "bun run test:e2e", /test:e2e/],
  // History, remote and queue control belong to the orchestrator.
  ["remo #1434", 'gh pr comment 1434 --body "@mergifyio queue"', /^gh/],
  ["rulo #1102", 'dir="$(git rev-parse --show-toplevel)/.claude/reviewed"; mkdir -p "$dir" && touch "$dir/$(git rev-parse HEAD)"; git push -q -u origin rulo/1102-title-lists-filters 2>&1 | tail -2', /^git push/],
  ["merge", "gh pr merge 1434 --squash", /^gh/],
];

describe("claude executor rails", () => {
  it.each(HARMLESS)("allows the harmless command from %s", (_source, command) => {
    expect(denyingRules(command)).toEqual([]);
  });

  it.each(DELIBERATE)("still denies the command from %s", (_source, command, rule) => {
    const denying = denyingRules(command);
    expect(denying.some((pattern) => rule.test(pattern))).toBe(true);
  });

  it("keeps both spellings of every stash subcommand it refuses", () => {
    for (const verb of ["push", "save", "pop", "apply", "drop", "clear", "store", "create", "branch", "export", "import"]) {
      expect(bashRules).toContain(`git stash ${verb} *`);
      expect(bashRules).toContain(`git stash ${verb}:*`);
    }
    expect(bashRules.filter((pattern) => /^git stash (list|show)/.test(pattern))).toEqual([]);
  });
});

/**
 * The pr-medic's ORCHESTRATOR rails (`pr-medic/orchestrator-settings.json`,
 * felipearos/ralph#247), read through the same model: the session may do a
 * coder's whole git workflow on the operator's branch except the push, which
 * goes through `pr-medic/push.ts`.
 */
describe("pr-medic orchestrator rails", () => {
  const medic = bashRulesOf(
    (JSON.parse(readFileSync(join(HOME, "pr-medic", "orchestrator-settings.json"), "utf8")) as { permissions: { deny: string[] } })
      .permissions.deny,
  );

  it.each([
    "git push",
    "git push origin HEAD:refs/heads/felipearosr/7-feature",
    "git push --force-with-lease=felipearosr/7-feature:abc1234 origin HEAD",
    "git push -f",
    "bun run typecheck && git push -q origin HEAD 2>&1 | tail -2",
  ])("denies `%s`", (command) => {
    expect(denyingRules(command, medic)).not.toEqual([]);
  });

  it.each([
    "bun pr-medic/push.ts 2197 --expect 3f9c2a1b7d",
    "bun ${RALPH_HOME}/pr-medic/push.ts 2197 --expect 3f9c2a1b7d",
    'git commit -m "fix: the push fence" --trailer "Pr-Medic: medi"',
    "git fetch origin && git rebase origin/main",
    "git log --oneline origin/felipearosr/7-feature..HEAD",
    "gh pr comment 2197 --body-file /tmp/note.md",
  ])("allows `%s`", (command) => {
    expect(denyingRules(command, medic)).toEqual([]);
  });
});

/**
 * The verifier's ORCHESTRATOR rails (`verifier/orchestrator-settings.json`,
 * felipearos/ralph#566): it checks production as the test account and never
 * writes to a database, so database clients and hand-made requests are
 * denied, while its own tools stay open.
 */
describe("verifier orchestrator rails", () => {
  const verifier = bashRulesOf(
    (JSON.parse(readFileSync(join(HOME, "verifier", "orchestrator-settings.json"), "utf8")) as { permissions: { deny: string[] } })
      .permissions.deny,
  );

  it.each([
    'psql "$DATABASE_URL" -c "delete from users"',
    "supabase db push",
    "mysql -e 'drop table x'",
    "curl -X POST https://loggd.app/api/entries",
    "wget https://loggd.app/",
    // It writes no code in any mode (#568): act mode's revert is the gate's.
    'git commit -m "fix"',
    "git commit --amend --no-edit",
    "git revert --no-edit abc123",
    "git cherry-pick abc123",
    "git merge origin/main",
    "git rebase origin/main",
    "git push origin HEAD:refs/heads/verifier/revert-12",
    "git push --force origin HEAD",
    "gh pr create --title x --body y",
    "gh pr merge 77 --squash",
    "gh api -X PUT repos/felipearos/loggd/pulls/77/merge",
  ])("denies `%s`", (command) => {
    expect(denyingRules(command, verifier)).not.toEqual([]);
  });

  it("denies every edit, leaving Write for its own .ralph/logs drafts", () => {
    const deny = (JSON.parse(readFileSync(join(HOME, "verifier", "orchestrator-settings.json"), "utf8")) as { permissions: { deny: string[] } })
      .permissions.deny;
    expect(deny).toEqual(expect.arrayContaining(["Edit", "NotebookEdit"]));
    expect(deny).not.toContain("Write");
  });

  it.each([
    'bun "$RALPH_HOME/verifier/acceptance.ts" login',
    'bun "$RALPH_HOME/verifier/acceptance.ts" page "/settings|click:Save"',
    'bun "$RALPH_HOME/verifier/acceptance.ts" probe GET /api/me',
    'bun "$RALPH_HOME/verifier/acceptance.ts" sql "select count(*) from entries"',
    'bun "$RALPH_HOME/verifier/checkin.ts" decide --acceptance .ralph/logs/acceptance-12.json',
    'bun "$RALPH_HOME/tracker.ts" view 184',
    "git status --short",
    "git log --oneline -5",
  ])("allows `%s`", (command) => {
    expect(denyingRules(command, verifier)).toEqual([]);
  });
});

/**
 * The sentinel's ORCHESTRATOR rails (`sentinel/orchestrator-settings.json`,
 * felipearos/ralph#681): it drafts a ticket from what the gate stored and
 * writes no code, no tracker entry and no network request, while its own
 * `sentinel/issue.ts` and the read-only tracker and git verbs stay open.
 */
describe("sentinel orchestrator rails", () => {
  const deny = (JSON.parse(readFileSync(join(HOME, "sentinel", "orchestrator-settings.json"), "utf8")) as { permissions: { deny: string[] } })
    .permissions.deny;
  const sentinel = bashRulesOf(deny);

  it.each([
    "git commit -m x",
    "git push origin HEAD",
    "git reset --hard HEAD~1",
    "gh pr create --title x --body y",
    "gh issue create --title x",
    "gh issue comment 1 --body x",
    "gh api -X POST repos/felipearos/loggd/issues -f title=x",
    "curl https://sentry.io/api/0/issues/1/",
    "wget https://sentry.io/",
    'bun "$RALPH_HOME/tracker.ts" comment 12 --body-file x',
    'bun "$RALPH_HOME/tracker.ts" label add 12 x',
    'bun "$RALPH_HOME/tracker.ts" done 12',
    'bun "$RALPH_HOME/tracker.ts" blocked 12',
  ])("denies `%s`", (command) => {
    expect(denyingRules(command, sentinel)).not.toEqual([]);
  });

  it("denies every edit, leaving Write for its own .ralph/logs drafts", () => {
    expect(deny).toEqual(expect.arrayContaining(["Edit", "NotebookEdit"]));
    expect(deny).not.toContain("Write");
  });

  it.each([
    'bun "$RALPH_HOME/sentinel/issue.ts" show',
    'bun "$RALPH_HOME/sentinel/issue.ts" draft --title x --body-file .ralph/logs/d.md',
    'bun "$RALPH_HOME/tracker.ts" view 184',
    "git log --oneline -5",
    "git blame -L 1,9 -- src/a.ts",
    "git status --short",
  ])("allows `%s`", (command) => {
    expect(denyingRules(command, sentinel)).toEqual([]);
  });
});

/**
 * The harness-wide orchestrator rails (`claude-orchestrator-settings.json`):
 * the session that reads ticket text may not run the project's secrets CLI
 * or read its store, and a role that carries its own file carries these too.
 */
describe("claude orchestrator rails", () => {
  const file = (path: string): string[] =>
    (JSON.parse(readFileSync(join(HOME, ...path.split("/")), "utf8")) as { permissions: { deny: string[] } })
      .permissions.deny;
  const harness = file("claude-orchestrator-settings.json");
  // Not `rules`: that name is this file's module-level binding and
  // `denyingRules`'s default second argument, so shadowing it would let a call
  // that forgot the argument silently test the EXECUTOR's rules and pass.
  const harnessRules = bashRulesOf(harness);

  // The `it.each` cases below cannot see a rule LEAVING this file: `Bash(x *)`
  // also matches the bare prefix, so `Bash(doppler *)` alone satisfies every
  // denied command, and nothing in this model reads a `Read(…)` rule at all.
  // Both holes were proved by deleting `Bash(doppler:*)` and
  // `Read(~/.doppler/**)` from both files and watching the whole suite stay
  // green. So pin the set itself, the way the stash block above pins its own.
  it("denies the secrets CLI, its store, the tracker credential, the Slack token and the screenshot account, and nothing else", () => {
    expect(harness).toEqual([
      "Bash(doppler *)",
      "Bash(doppler:*)",
      "Bash(* ~/.doppler/*)",
      "Read(~/.doppler/**)",
      // The tracker credential (#335): the session reaches Linear or Jira only through tracker.ts.
      "Bash(* ~/.config/ralph/trackers/*)",
      "Read(~/.config/ralph/trackers/**)",
      // The Slack plugin's bot token: only the plugin, a subprocess of push-notification.ts, reads it.
      "Bash(* ~/.config/ralph/slack/*)",
      "Read(~/.config/ralph/slack/**)",
      // The screenshot test account: only ui-shots.ts reads it.
      "Bash(* ~/.config/ralph/screenshots/*)",
      "Read(~/.config/ralph/screenshots/**)",
    ]);
  });

  it.each([
    "doppler secrets",
    "doppler secrets get PRODUCTION_MIGRATIONS_DATABASE_URL --plain",
    "doppler secrets download --no-file --format env",
    "doppler run -- bun run test",
    "cat ~/.doppler/.doppler.yaml",
    "bun run typecheck && doppler secrets --only-names",
    "cat ~/.config/ralph/trackers/acme-backoffice.json",
    "cat ~/.config/ralph/slack/acme-pwa.json",
    "cat ~/.config/ralph/screenshots/acme-pwa.env",
  ])("denies `%s`", (command) => {
    expect(denyingRules(command, harnessRules)).not.toEqual([]);
  });

  it.each([
    "bun run test",
    "git push origin HEAD",
    "gh pr view 7 --json state",
    "bun ${RALPH_HOME}/bk-log.ts 3205",
    'bun "$RALPH_HOME/ci-log.ts" --pr 12 --rerun',
    'bun "$RALPH_HOME/tracker.ts" view 184',
    'bun "$RALPH_HOME/tracker.ts" done 184',
    'bun "$RALPH_HOME/ui-shots.ts" capture after /modules/checklist',
  ])("allows `%s`", (command) => {
    expect(denyingRules(command, harnessRules)).toEqual([]);
  });

  it("is repeated by every role file that replaces it", () => {
    for (const role of ["pr-medic/orchestrator-settings.json", "clerk/orchestrator-settings.json", "verifier/orchestrator-settings.json",
      "sentinel/orchestrator-settings.json"]) {
      for (const rule of harness) expect(file(role)).toContain(rule);
    }
  });
});
