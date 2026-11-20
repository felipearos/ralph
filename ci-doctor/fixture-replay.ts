/**
 * Replay recorded loggd CI for the ci-doctor's tests: a fake Buildkite that
 * serves `fixtures/ci-doctor/builds.json` and the job logs beside it, as the
 * API would have at a given moment, and a git that answers from
 * `fixtures/ci-doctor/git.json`, recorded from the loggd clone.
 *
 * The builds are loggd's builds that finished 2026-09-27..28 (UTC), plus
 * 2622–2630 from 2026-09-29, trimmed to the fields the scan reads (no author
 * or creator). The logs are the failed jobs' logs, cleaned and trimmed to the
 * lines `digestLog` reads; its digest of each is the same as of the whole log.
 *
 * One edit to the recording: loggd's step whose key shared the old name of the
 * verifier role carries `verifier` as its key here, since #679 keeps that word
 * out of the tree until #678's new role takes it. The scan reads step keys as
 * opaque strings, so nothing it reports changes.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { API, type Fetcher } from "../bk-log";
import { RALPH_HOME } from "../paths";
import { gitIn, type ApiBuild, type GitRun } from "./scan";

export const FIXTURE_DIR = join(RALPH_HOME, "fixtures", "ci-doctor");
export const ORG = "felipe-aros";
export const PIPELINE = "loggd";

export const loadBuilds = (): ApiBuild[] => JSON.parse(readFileSync(join(FIXTURE_DIR, "builds.json"), "utf8")) as ApiBuild[];

export interface FakeBuildkite {
  fetcher: Fetcher;
  /** Every path requested, in order. */
  calls: string[];
  /** The moment the API answers for: builds finished later do not exist yet. */
  setNow(ms: number): void;
}

const response = (status: number, body: string, type = "application/json"): Response =>
  new Response(body, { status, headers: { "content-type": type } });

/**
 * A Buildkite that knows `builds` (newest first, as the API lists them) and
 * serves a job's log from `logs[jobId]`, else the recorded fixture log.
 */
export function fakeBuildkite(builds: readonly ApiBuild[], logs: Record<string, string> = {}): FakeBuildkite {
  let now = Infinity;
  const calls: string[] = [];
  const fetcher: Fetcher = async (url) => {
    const path = url.startsWith(API) ? url.slice(API.length) : url;
    calls.push(path);
    const list = new RegExp(`^/organizations/${ORG}/pipelines/${PIPELINE}/builds\\?(.*)$`).exec(path);
    if (list) {
      const query = new URLSearchParams(list[1]!);
      const from = query.get("finished_from") ?? "";
      const perPage = Number(query.get("per_page") ?? 30);
      const page = Number(query.get("page") ?? 1);
      const visible = builds
        .filter((build) => build.finished_at && build.finished_at >= from && Date.parse(build.finished_at) <= now)
        .sort((a, b) => b.number - a.number);
      return response(200, JSON.stringify(visible.slice((page - 1) * perPage, page * perPage)));
    }
    const log = new RegExp(`^/organizations/${ORG}/pipelines/${PIPELINE}/builds/\\d+/jobs/([^/]+)/log$`).exec(path);
    if (log) {
      const id = log[1]!;
      if (id in logs) return response(200, logs[id]!, "text/plain");
      const file = join(FIXTURE_DIR, "logs", `${id}.log`);
      return existsSync(file) ? response(200, readFileSync(file, "utf8"), "text/plain") : response(404, JSON.stringify({ message: "Not Found" }));
    }
    return response(404, JSON.stringify({ message: "Not Found" }));
  };
  return {
    fetcher,
    calls,
    setNow(ms: number) {
      now = ms;
    },
  };
}

/** The recorded answers, keyed by the git arguments joined with a space. `null`: git failed. */
export const loadGit = (): Record<string, string | null> =>
  JSON.parse(readFileSync(join(FIXTURE_DIR, "git.json"), "utf8")) as Record<string, string | null>;

/**
 * A git that answers from a record. `fetch` succeeds and does nothing; an
 * unrecorded question fails and is listed in `misses`.
 *
 * To re-record, run the tests with `CI_DOCTOR_RECORD_GIT=<a loggd clone>`:
 * unrecorded questions are then asked of that clone (never fetching into it)
 * and written to `git.json`.
 */
export function replayGit(record: Record<string, string | null>, misses: string[] = []): GitRun {
  const clone = process.env.CI_DOCTOR_RECORD_GIT?.trim();
  const live = clone ? gitIn(clone) : null;
  return (args) => {
    if (args[0] === "fetch") return args.length > 4 ? null : "";
    const key = args.join(" ");
    if (key in record) return record[key]!;
    if (live !== null) {
      record[key] = live(args);
      writeFileSync(join(FIXTURE_DIR, "git.json"), `${JSON.stringify(record, Object.keys(record).sort(), 1)}\n`);
      return record[key]!;
    }
    misses.push(key);
    return null;
  };
}
