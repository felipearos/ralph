import { spawnSync } from "node:child_process";

export interface Called {
  ok: boolean;
  result: Record<string, unknown> | null;
  why: string;
  kind: CallFailure | null;
  code: string | null;
}

export type CallFailure = "missing-cli" | "unlaunchable" | "timed-out" | "unparseable" | "refused";

const timeoutMs = (): number => {
  const raw = Number(process.env.RALPH_ORCA_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 15_000;
};

export const orcaCli = (): string => process.env.RALPH_ORCA_CLI ?? "orca";

export function invokeOrca(
  verb: string,
  args: string[],
  allowed: readonly string[],
  who: string,
  forbidden: readonly string[] = ["--inject"],
  timeout: number = timeoutMs(),
): Called {
  if (!allowed.includes(verb)) throw new Error(`${who} may not run '${verb}'`);
  for (const arg of args) {
    if (forbidden.some((flag) => arg === flag || arg.startsWith(`${flag}=`))) {
      throw new Error(`${who} may not pass '${arg}'`);
    }
  }
  const ran = spawnSync(orcaCli(), [...verb.split(" "), ...args, "--json"], {
    encoding: "utf8",
    timeout,
    maxBuffer: 8 * 1024 * 1024,
  });
  const failed = (kind: CallFailure, why: string, code: string | null = null): Called => ({
    ok: false,
    result: null,
    why,
    kind,
    code,
  });
  if (ran.error != null) {
    const errno = (ran.error as NodeJS.ErrnoException).code;
    return errno === "ENOENT"
      ? failed("missing-cli", "no Orca CLI on PATH")
      : failed("unlaunchable", `orca ${verb} could not run (${errno ?? ran.error.message})`);
  }
  if (ran.signal !== null) return failed("timed-out", `orca ${verb} timed out`);
  let envelope: unknown;
  try {
    envelope = JSON.parse(ran.stdout);
  } catch {
    return failed("unparseable", `orca ${verb} returned something this mirror cannot parse`);
  }
  if (typeof envelope !== "object" || envelope === null) {
    return failed("unparseable", `orca ${verb} returned no envelope`);
  }
  const value = envelope as Record<string, unknown>;
  if (value.ok !== true) {
    const error = value.error as Record<string, unknown> | undefined;
    const code = typeof error?.code === "string" ? error.code : null;
    const detail = typeof error?.message === "string" ? error.message : "";
    return failed(
      "refused",
      `orca ${verb}: ${code ?? "refused"}${detail === "" ? "" : ` — ${detail}`}`,
      code,
    );
  }
  const result = value.result;
  return {
    ok: true,
    result: typeof result === "object" && result !== null ? result as Record<string, unknown> : {},
    why: "",
    kind: null,
    code: null,
  };
}
