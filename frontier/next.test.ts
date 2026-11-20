/**
 * The launcher's whole job is choosing a source, and choosing wrong is silent:
 * running main's copy while you edit the tool, or the checkout's copy while you
 * expect the pin, both produce plausible output with no sign anything is off.
 * These pin the precedence and the message that explains it.
 */

import { describe, expect, it } from 'vitest';

import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import {
  candidatePaths,
  chooseSource,
  exitCodeFor,
  explain,
  isDeveloping,
  materialise,
  relativeImports,
  splitArgs,
} from './next';

describe('splitArgs', () => {
  it('consumes --local and forwards everything else', () => {
    expect(splitArgs(['--local', '--dry-run'])).toEqual({
      forcedLocal: true,
      rest: ['--dry-run'],
    });
  });

  it('leaves the payload flags untouched when --local is absent', () => {
    expect(splitArgs(['--dry-run'])).toEqual({ forcedLocal: false, rest: ['--dry-run'] });
  });

  it('does not leak --local through to the payload, which rejects unknown flags', () => {
    expect(splitArgs(['--local']).rest).toEqual([]);
  });

  it('drops the leading -- an operator types, so `next.ts -- --dry-run` works', () => {
    expect(splitArgs(['--', '--dry-run'])).toEqual({ forcedLocal: false, rest: ['--dry-run'] });
    expect(splitArgs(['--', '--local', '--take-one'])).toEqual({ forcedLocal: true, rest: ['--take-one'] });
  });
});

describe('chooseSource', () => {
  const state = {
    forcedLocal: false,
    developingPayload: false,
    pinnedAvailable: true,
  };

  it('pins to origin/main by default', () => {
    expect(chooseSource(state)).toBe('pinned');
  });

  it('honours an explicit --local', () => {
    expect(chooseSource({ ...state, forcedLocal: true })).toBe('local');
  });

  it('prefers the checkout while this branch is changing the tool', () => {
    // Otherwise editing the tool would silently exercise main's copy — and
    // committing the work would be the thing that triggers it.
    expect(chooseSource({ ...state, developingPayload: true })).toBe('local');
  });

  it('degrades to the checkout when origin/main cannot be read', () => {
    // A stale frontier beats no frontier when the network is down.
    expect(chooseSource({ ...state, pinnedAvailable: false })).toBe('local');
  });

  it('still runs locally when the pin is unavailable and edits exist', () => {
    expect(
      chooseSource({ ...state, developingPayload: true, pinnedAvailable: false }),
    ).toBe('local');
  });
});

describe('explain', () => {
  const state = { forcedLocal: false, developingPayload: false, pinnedAvailable: true };

  it('says nothing on the expected path', () => {
    expect(explain('pinned', state)).toBeNull();
  });

  it('distinguishes the three ways the checkout wins', () => {
    expect(explain('local', { ...state, forcedLocal: true })).toContain('--local');
    expect(explain('local', { ...state, developingPayload: true })).toContain(
      'this branch changes it',
    );
    expect(explain('local', { ...state, pinnedAvailable: false })).toContain('origin/main');
  });
});

describe('exitCodeFor', () => {
  it('passes an ordinary exit code straight through, zero included', () => {
    expect(exitCodeFor(0, null)).toBe(0);
    expect(exitCodeFor(2, null)).toBe(2);
  });

  it('reports a signalled child by the shell convention, not as a plain failure', () => {
    // Collapsing SIGINT to 1 would report an interrupted run as a failed one.
    expect(exitCodeFor(null, 'SIGINT')).toBe(130);
    expect(exitCodeFor(null, 'SIGTERM')).toBe(143);
  });

  it('falls back to 1 when there is neither a code nor a signal', () => {
    expect(exitCodeFor(null, null)).toBe(1);
  });
});

describe('isDeveloping', () => {
  const state = { identical: false, dirty: false, aheadCommits: false };

  it('says no when the two copies agree, whatever the history says', () => {
    // After a squash merge the branch keeps its own commit forever, so
    // origin/main..HEAD never empties — a history-only test would strand that
    // branch on its local copy for good.
    expect(isDeveloping({ identical: true, dirty: false, aheadCommits: true })).toBe(false);
  });

  it('says yes for uncommitted edits', () => {
    expect(isDeveloping({ ...state, dirty: true })).toBe(true);
  });

  it('says yes once the work is committed', () => {
    // Committing must not be the thing that makes the launcher ignore you.
    expect(isDeveloping({ ...state, aheadCommits: true })).toBe(true);
  });

  it('says no for a merely stale branch', () => {
    // Behind main, not ahead of it: different content, but no work to protect.
    expect(isDeveloping(state)).toBe(false);
  });
});

/**
 * The pinned copy is run out of a temp directory, so anything it imports has to
 * be fetched and placed there too. It was not: the payload was written alone as
 * a flat file, which held only while it imported nothing but `node:` builtins.
 * #708 gave it `../ralph/claim-lease` (now `../claim-lease`) and `bun run next` began failing outright
 * — while `--local` kept working, so the break was invisible from any branch
 * developing the tool.
 */
describe('relativeImports', () => {
  it('finds the shapes an import can arrive in', () => {
    const source = [
      'import { readFile } from "node:fs/promises";',
      'import { claimLease } from "../claim-lease";',
      "import { helper } from './helper';",
      'import "./side-effect";',
      'export { thing } from "../lib/thing";',
      'const late = await import("./dynamic");',
    ].join('\n');

    expect(relativeImports(source).sort()).toEqual([
      './dynamic',
      './helper',
      './side-effect',
      '../lib/thing',
      '../claim-lease',
    ].sort());
  });

  it('skips what the temp tree does not need to carry', () => {
    // `node:` builtins resolve anywhere; a bare package would need
    // `node_modules`, which the temp tree has no access to either way.
    expect(relativeImports('import { join } from "node:path";')).toEqual([]);
    expect(relativeImports('import { z } from "zod";')).toEqual([]);
  });

  it('names each module once however often it is imported', () => {
    const source = 'import { a } from "./x";\nimport { b } from "./x";';
    expect(relativeImports(source)).toEqual(['./x']);
  });
});

describe('candidatePaths', () => {
  it('resolves against the importing file, in the order TypeScript would try', () => {
    // The real case: `frontier/next-tasks.ts` importing `../claim-lease`
    // has to become `claim-lease.ts`, which is what git can be asked for.
    expect(candidatePaths('frontier/next-tasks.ts', '../claim-lease')).toEqual([
      'claim-lease.ts',
      'claim-lease.tsx',
      'claim-lease/index.ts',
      'claim-lease',
    ]);
  });

  it('keeps a sibling import inside its own directory', () => {
    expect(candidatePaths('frontier/next-tasks.ts', './helper')[0]).toBe('frontier/helper.ts');
  });

  it('keeps an explicit extension rather than doubling it', () => {
    expect(candidatePaths('frontier/next-tasks.ts', '../claim-lease.ts')).toContain(
      'claim-lease.ts',
    );
  });
});

describe('materialise', () => {
  /** `git show origin/main:<path>` for a repo that exists only in this test. */
  const repo = (files: Record<string, string>) => {
    const asked: string[] = [];
    return {
      asked,
      read: (path: string): Promise<string | null> => {
        asked.push(path);
        return Promise.resolve(files[path] ?? null);
      },
    };
  };

  it('writes the payload with what it imports, at the paths it imports them by', async () => {
    // The exact break: a flat copy leaves `../ralph/claim-lease` unresolvable,
    // and the layout is what makes the specifier mean the same thing in the
    // temp tree as in the checkout.
    const payload = 'import { claimLease } from "../claim-lease";\n';
    const { asked, read } = repo({
      'claim-lease.ts': 'export const claimLease = () => null;\n',
    });

    const pinned = await materialise(payload, read);
    try {
      expect(pinned.file).toBe(join(pinned.dir, 'frontier/next-tasks.ts'));
      expect(await readFile(pinned.file, 'utf8')).toBe(payload);
      expect(await readFile(join(pinned.dir, 'claim-lease.ts'), 'utf8')).toContain(
        'claimLease',
      );
      expect(asked).toContain('claim-lease.ts');
    } finally {
      await rm(pinned.dir, { recursive: true, force: true });
    }
  });

  it('follows the closure, not just the first layer', async () => {
    const { read } = repo({
      'claim-lease.ts': 'import { deep } from "./deep";\nexport { deep };\n',
      'deep.ts': 'export const deep = 1;\n',
    });

    const pinned = await materialise('import "../claim-lease";\n', read);
    try {
      expect(await readFile(join(pinned.dir, 'deep.ts'), 'utf8')).toContain('deep');
    } finally {
      await rm(pinned.dir, { recursive: true, force: true });
    }
  });

  it('does not loop on modules that import each other', async () => {
    const { read } = repo({
      'ralph/a.ts': 'import "./b";\n',
      'ralph/b.ts': 'import "./a";\n',
    });

    const pinned = await materialise('import "../ralph/a";\n', read);
    try {
      expect(await readFile(join(pinned.dir, 'ralph/b.ts'), 'utf8')).toContain('import');
    } finally {
      await rm(pinned.dir, { recursive: true, force: true });
    }
  });

  it('fetches a shared dependency once, not once per importer', async () => {
    // The diamond: the payload reaches `c` through both `a` and `b`. This is
    // the path the `written` short-circuit exists for, and fetching twice
    // would mean a large closure paid a `git show` per edge rather than per
    // file.
    const { asked, read } = repo({
      'ralph/a.ts': 'import "./c";\n',
      'ralph/b.ts': 'import "./c";\n',
      'ralph/c.ts': 'export const c = 1;\n',
    });

    const pinned = await materialise('import "../ralph/a";\nimport "../ralph/b";\n', read);
    try {
      expect(await readFile(join(pinned.dir, 'ralph/c.ts'), 'utf8')).toContain('c = 1');
      expect(asked.filter((path) => path === 'ralph/c.ts')).toHaveLength(1);
    } finally {
      await rm(pinned.dir, { recursive: true, force: true });
    }
  });

  it('carries on when a relative import names nothing git has', async () => {
    // A stale or generated path must not take the whole launcher down: the
    // payload still runs, and bun reports the missing module itself.
    const { read } = repo({});
    const pinned = await materialise('import "./gone";\n', read);
    try {
      expect(await readFile(pinned.file, 'utf8')).toContain('./gone');
    } finally {
      await rm(pinned.dir, { recursive: true, force: true });
    }
  });
});
