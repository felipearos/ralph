/**
 * The sentinel's named-secret checker (felipearos/ralph#681, spec #678): the
 * supervisor runs it before handing the Sentry read token to the sentinel's
 * gate, from the project's worktree, which is where the `sentinel` block —
 * the org, project and environment the token must read — comes from.
 *
 *   bun sentinel/credentials.ts --check-token sentry   can the token read the configured project, and only read it?
 *
 * Exit codes: 0 usable (or unproved: the reporter could not be reached) · 1 refused · 64 usage.
 * The token itself is never printed: these messages land in the loop's log.
 */
import { loadProjectConfig, sentinelRules, type SentinelRules } from "../project-config";
import { projectRoot } from "../paths";
import { createSentryReporter } from "../reporter/sentry";
import type { Fetch } from "../reporter/types";

export const SENTRY_TOKEN_ENV = "RALPH_SENTINEL_SENTRY_TOKEN";

/** Overridable so a test, or the gate's spawned test, can answer for Sentry locally. */
export const SENTRY_API_ENV = "RALPH_SENTINEL_SENTRY_API";

export const TOKEN_KINDS = ["sentry"] as const;
export type TokenKind = (typeof TOKEN_KINDS)[number];

const PREFIX = "sentinel-credentials: ";

export interface CheckResult {
  code: number;
  message: string;
}

/**
 * A reporter outage or no network is not the token's fault, so the token is
 * handed over unproved: exit 0. The supervisor withholds a token on ANY other
 * exit, and preflight then denies the loop as "stored but withheld" — so a
 * 503 from Sentry, or a boot that started the loop before the network was up,
 * would leave a sentinel stopped all night over a token that is fine. A token
 * that can write is refused when it IS reachable, and the gate degrades a
 * refused read to a quiet poll, so a bad token handed over this way costs a
 * quiet gate, not a wrong action; the next start proves it again.
 */
const unproved = (why: string): CheckResult => ({
  code: 0,
  message: `${PREFIX}Sentry could not be reached (${why}); handing the token over unproved, and the next start checks it again`,
});

/**
 * `--check-token sentry`: the token reads what the project's `sentinel` block
 * names, and carries no write scope. `rules` is null when the project has no
 * block; the CLI loads it, a test hands it in.
 */
export async function checkToken(
  kind: TokenKind,
  deps: { env: NodeJS.ProcessEnv; rules: SentinelRules | null; fetcher?: Fetch },
): Promise<CheckResult> {
  if (kind !== "sentry") return { code: 64, message: `${PREFIX}unknown token kind ${JSON.stringify(kind)}` };
  const token = deps.env[SENTRY_TOKEN_ENV]?.trim() ?? "";
  if (token === "") return { code: 1, message: `${PREFIX}no ${SENTRY_TOKEN_ENV} in the environment` };
  const { rules } = deps;
  if (rules === null) return { code: 1, message: `${PREFIX}the project's .ralph/config.json has no 'sentinel' block` };
  const { org, project, environment } = rules.reporter;
  const reporter = createSentryReporter({
    org,
    project,
    environment,
    token,
    fetcher: deps.fetcher ?? fetch,
    apiBase: deps.env[SENTRY_API_ENV]?.trim() || undefined,
  });
  const access = await reporter.checkAccess();
  const result: CheckResult = !access.reachable
    ? unproved(access.why)
    : access.access === "ok"
      ? { code: 0, message: `${PREFIX}Sentry token ok, reads ${org}/${project} with ${access.scopes.join(", ") || "no scopes"}` }
      : {
          code: 1,
          message: `${PREFIX}Sentry refused ${SENTRY_TOKEN_ENV} for ${org}/${project}: ${access.why}; store a read-only token (project:read, event:read, org:read)`,
        };
  // A vendor error message could echo the header back; never let it reach a log.
  return { ...result, message: result.message.split(token).join("<redacted>") };
}

/** The project's rules, or a refusal when its config cannot be read. */
function rulesAt(root: string): { rules: SentinelRules | null } | CheckResult {
  try {
    return { rules: sentinelRules(loadProjectConfig(root)) };
  } catch (error) {
    return { code: 1, message: `${PREFIX}the project's config could not be read: ${(error as Error).message.split("\n")[0]}` };
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const kind = argv[1];
  if (argv.length !== 2 || argv[0] !== "--check-token" || !(TOKEN_KINDS as readonly string[]).includes(kind ?? "")) {
    console.error("usage: bun sentinel/credentials.ts --check-token sentry");
    process.exitCode = 64;
  } else {
    const loaded = rulesAt(projectRoot());
    const { code, message } = "code" in loaded
      ? loaded
      : await checkToken(kind as TokenKind, { env: process.env, rules: loaded.rules });
    (code === 0 ? console.log : console.error)(message);
    process.exitCode = code;
  }
}
