/**
 * A scripted, recording `Executor` shared by the dashboard suites.
 *
 * Test infrastructure, not shipped code, but kept out of `*.test.ts` (like
 * `fixtures.ts`) so every suite that drives the adapters through a fake
 * executor scripts and inspects it the same way, instead of each growing its
 * own `switch` over the invocation and its own `calls.push`.
 *
 * No subprocess runs and nothing touches the disk: a rule decides what each
 * invocation answers, and every call is kept, in order, with that answer.
 */
import type { ExecResult, Executor, Invocation } from "./control-adapter";

/** Which invocations a rule answers: a predicate, or a command plus an argv prefix. */
export type Matcher = ((invocation: Invocation) => boolean) | { command?: string; args?: readonly string[] };

/**
 * What a matched invocation gets: a fixed result, one computed at call time
 * (so a test can re-script by mutating the state the function reads), or a
 * rejection — the path `guarded()` exists for.
 */
export type Answer = ExecResult | ((invocation: Invocation) => ExecResult) | { throw: unknown };

export interface Rule {
  match: Matcher;
  answer: Answer;
}

export interface RecordedCall {
  invocation: Invocation;
  /** What the executor answered, or null for a call it rejected. */
  answer: ExecResult | null;
  /** The rejection, when the answer was a throw. */
  error?: unknown;
}

export interface RecordingExecutorOptions {
  rules?: Rule[];
  /** Answers an invocation no rule matches; defaults to {@link unexpected}. */
  fallback?: Answer;
}

export interface RecordingExecutor {
  exec: Executor;
  /** Every call so far, in the order they arrived — including {@link record}ed ones. */
  calls: RecordedCall[];
  /** The live script: first match wins, and a test may push, splice or replace rules mid-test. */
  rules: Rule[];
  fallback: Answer;
  /** Appends a rule; returns the executor so a script reads as a chain. */
  on: (match: Matcher, answer: Answer) => RecordingExecutor;
  /**
   * Logs a call that did not go through `exec` — a fake beside the executor,
   * such as an inbox delivery — so ordering assertions see one sequence.
   */
  record: (invocation: Invocation, answer: ExecResult) => void;
}

/** The default fallback: a status no real CLI here uses, naming what slipped through. */
export const unexpected = (invocation: Invocation): ExecResult => ({
  status: 127,
  stdout: "",
  stderr: `unexpected invocation: ${invocation.command}`,
});

/** Whether a rule's matcher answers an invocation: the one rule every caller of a matcher applies. */
export const matches = (match: Matcher, invocation: Invocation): boolean => {
  if (typeof match === "function") return match(invocation);
  if (match.command !== undefined && match.command !== invocation.command) return false;
  return (match.args ?? []).every((arg, index) => invocation.args[index] === arg);
};

export function createRecordingExecutor(options: RecordingExecutorOptions = {}): RecordingExecutor {
  const recorder: RecordingExecutor = {
    calls: [],
    rules: [...(options.rules ?? [])],
    fallback: options.fallback ?? unexpected,
    on: (match, answer) => {
      recorder.rules.push({ match, answer });
      return recorder;
    },
    record: (invocation, answer) => {
      recorder.calls.push({ invocation, answer });
    },
    exec: async (invocation) => {
      const answer = recorder.rules.find((rule) => matches(rule.match, invocation))?.answer ?? recorder.fallback;
      if (typeof answer === "object" && "throw" in answer) {
        recorder.calls.push({ invocation, answer: null, error: answer.throw });
        throw answer.throw;
      }
      if (typeof answer !== "function") {
        recorder.calls.push({ invocation, answer });
        return answer;
      }
      // A function answer may throw to script a call-time rejection; record it
      // like a throw rule, or the failing step would vanish from the sequence.
      let result: ExecResult;
      try {
        result = answer(invocation);
      } catch (error) {
        recorder.calls.push({ invocation, answer: null, error });
        throw error;
      }
      recorder.calls.push({ invocation, answer: result });
      return result;
    },
  };
  return recorder;
}

/**
 * Lets the invocations no rule matches run on a real executor the caller
 * supplies, unrecorded, so `calls` holds only the scripted reads. For the
 * adapter suites that script one read and let every other run the real CLI
 * against a scratch fixture; the subprocess is the caller's, never this module's.
 */
export function fallThrough(recorder: RecordingExecutor, real: Executor): RecordingExecutor {
  const scripted = recorder.exec;
  recorder.exec = (invocation) =>
    recorder.rules.some((rule) => matches(rule.match, invocation)) ? scripted(invocation) : real(invocation);
  return recorder;
}
