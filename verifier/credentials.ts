/**
 * The verifier's named-secret checker (felipearos/ralph#561): the supervisor
 * runs it before handing a read token to the verifier's gate, from the
 * project's worktree, which is where the Sentry project and the deploy source
 * come from.
 *
 *   bun verifier/credentials.ts --check-token sentry   can the token read the configured Sentry project?
 *   bun verifier/credentials.ts --check-token vercel   can the token read the configured Vercel project?
 *
 * Exit codes: 0 usable · 1 refused · 2 the vendor could not be reached · 64 usage.
 * The token itself is never printed: these messages land in the loop's log.
 */
import { loadProjectConfig, verifierRules, type VerifierRules } from "../project-config";
import { projectRoot } from "../paths";

/** The fetch shape the checks call, so a test hands in a fake vendor. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export const SENTRY_TOKEN_ENV = "RALPH_VERIFIER_SENTRY_TOKEN";
export const VERCEL_TOKEN_ENV = "RALPH_VERIFIER_VERCEL_TOKEN";

export const TOKEN_KINDS = ["sentry", "vercel"] as const;
export type TokenKind = (typeof TOKEN_KINDS)[number];

export const CALL_TIMEOUT_MS = 20_000;

const PREFIX = "verifier-credentials: ";

/** One GET with the token as a bearer, mapped onto the checker's three codes. */
/**
 * A vendor outage or no network is not the token's fault, so the token is
 * handed over unproved: exit 0. The supervisor withholds a token on ANY other
 * exit, and preflight then denies the loop as "stored but withheld" — so a
 * 503 from Sentry, or a boot that started the loop before the network was up,
 * would leave a verifier stopped all night over a token that is fine. Both
 * tokens only read, and the gate degrades a refused call to idle or
 * inconclusive, so a bad token handed over this way costs a quiet gate, not a
 * wrong action; the next start proves it again.
 */
const unproved = (why: string): { code: number; message: string } => ({
  code: 0,
  message: `${PREFIX}${why}; handing the token over unproved, and the next start checks it again`,
});

async function probe(
  url: string,
  token: string,
  fetcher: Fetch,
  ok: string,
  refused: (status: number) => string,
): Promise<{ code: number; message: string }> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
  } catch (error) {
    return unproved(`${new URL(url).host} could not be reached: ${(error as Error).message}`);
  }
  if (response.ok) return { code: 0, message: `${PREFIX}${ok}` };
  if (response.status >= 500 || response.status === 429) {
    return unproved(`${new URL(url).host} answered ${response.status}`);
  }
  return { code: 1, message: `${PREFIX}${refused(response.status)}` };
}

function sentryCheck(rules: VerifierRules, token: string, fetcher: Fetch): Promise<{ code: number; message: string }> {
  const { org, project } = rules.sentry;
  const target = `${org}/${project}`;
  return probe(
    `https://sentry.io/api/0/projects/${encodeURIComponent(org)}/${encodeURIComponent(project)}/`,
    token,
    fetcher,
    `Sentry token ok, reads ${target}`,
    (status) =>
      status === 401
        ? `Sentry refused ${SENTRY_TOKEN_ENV} (401): the token is invalid or revoked; store a fresh read-only token with project:read`
        : status === 403
          ? `Sentry refused ${SENTRY_TOKEN_ENV} for ${target} (403): give the token project:read on org ${org}`
          : status === 404
            ? `Sentry has no project ${target} the token can see (404): check \`verifier.sentry\` in .ralph/config.json, or the token's org`
            : `Sentry answered ${status} for ${target}; store a read-only token with project:read as ${SENTRY_TOKEN_ENV}`,
  );
}

function vercelCheck(rules: VerifierRules, token: string, fetcher: Fetch): Promise<{ code: number; message: string }> {
  if (rules.deploy.source !== "vercel") {
    return Promise.resolve({
      code: 1,
      message: `${PREFIX}the project's deploy source is ${rules.deploy.source}, not vercel, so it has no use for ${VERCEL_TOKEN_ENV}`,
    });
  }
  const { project, team } = rules.deploy;
  // Vercel names a team by id (`team_…`) in `teamId` and by its URL slug in
  // `slug`; sending a slug as an id is refused, which would withhold a good
  // token over a config spelling.
  const query = team === null ? "" : team.startsWith("team_") ? `?teamId=${encodeURIComponent(team)}` : `?slug=${encodeURIComponent(team)}`;
  const target = team === null ? project : `${project} (team ${team})`;
  return probe(
    `https://api.vercel.com/v9/projects/${encodeURIComponent(project)}${query}`,
    token,
    fetcher,
    `Vercel token ok, reads ${target}`,
    (status) =>
      status === 401
        ? `Vercel refused ${VERCEL_TOKEN_ENV} (401): the token is invalid or expired; store a fresh one`
        : status === 403
          ? `Vercel refused ${VERCEL_TOKEN_ENV} for ${target} (403): scope the token to the team that owns the project`
          : status === 404
            ? `Vercel has no project ${target} the token can see (404): check \`verifier.deploy.project\` and \`verifier.deploy.team\` in .ralph/config.json`
            : `Vercel answered ${status} for ${target}; store a token that reads the project as ${VERCEL_TOKEN_ENV}`,
  );
}

/**
 * `--check-token <kind>`: the credential reads what the project's `verifier`
 * block names. Run by the supervisor before handing it to the gate.
 */
export async function checkToken(
  kind: TokenKind,
  env: NodeJS.ProcessEnv,
  root: string,
  fetcher: Fetch = fetch,
): Promise<{ code: number; message: string }> {
  const name = kind === "sentry" ? SENTRY_TOKEN_ENV : VERCEL_TOKEN_ENV;
  const token = env[name]?.trim() ?? "";
  if (token === "") return { code: 1, message: `${PREFIX}no ${name} in the environment` };
  let rules: VerifierRules | null;
  try {
    rules = verifierRules(loadProjectConfig(root));
  } catch (error) {
    return { code: 1, message: `${PREFIX}the project's config could not be read: ${(error as Error).message.split("\n")[0]}` };
  }
  if (rules === null) return { code: 1, message: `${PREFIX}the project's .ralph/config.json has no 'verifier' block` };
  const result = await (kind === "sentry" ? sentryCheck(rules, token, fetcher) : vercelCheck(rules, token, fetcher));
  // A vendor error message could echo the header back; never let it reach a log.
  return { ...result, message: result.message.split(token).join("<redacted>") };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const kind = argv[1];
  if (argv.length !== 2 || argv[0] !== "--check-token" || !(TOKEN_KINDS as readonly string[]).includes(kind ?? "")) {
    console.error("usage: bun verifier/credentials.ts --check-token sentry|vercel");
    process.exitCode = 64;
  } else {
    const { code, message } = await checkToken(kind as TokenKind, process.env, projectRoot());
    (code === 0 ? console.log : console.error)(message);
    process.exitCode = code;
  }
}
