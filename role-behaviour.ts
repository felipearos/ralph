#!/usr/bin/env bun
/**
 * What `ralph.sh` needs to know about the role it is running, rendered as
 * shell.
 *
 * The supervisor used to carry a coder's answers inline: the sigil patterns,
 * the phase machinery, the one Buildkite secret it reads by name, the host
 * lease around every turn. Each of those is now a field on the role descriptor
 * (`roles.ts`), and this module is how a shell script reads them — one
 * `eval "$(bun role-behaviour.ts --export <role>)"` in place of a `case`
 * statement per behaviour, so adding a role never edits `ralph.sh`.
 *
 * It renders values, not policy: what to do with a role that has no phases or
 * a secret targeted at the gate is the supervisor's, and the descriptor's
 * comments say why each answer is what it is.
 *
 * Usage:
 *
 *   bun role-behaviour.ts --export <role>   shell `export` lines to eval
 *   bun role-behaviour.ts --json <role>     the same values as JSON
 */

import { ROLES, isRole, roleDescriptor, type Role, type RoleSecret, type SecretTarget, type Sigil } from "./roles";
import { shellQuote } from "./project-config";
import { STOP_SIGILS, type StopSigil } from "./phase";

/**
 * A role's stop set is `ralph/phase.ts`'s roster filtered, never re-ordered.
 *
 * Imported rather than re-listed, so adding a terminal sigil there reaches
 * every role's set — a local copy would let the two drift, and the drift's
 * symptom is a sigil silently unmatched at runtime. `roles.test.ts` fences
 * `SIGILS` against the same roster.
 *
 * The ORDER is `phase.ts`'s so the two read the same way. It is not what makes
 * the supervisor's precedence: `ralph.sh` turns this list into one `grep -E`
 * alternation, where order cannot matter, and settles the precedence in its own
 * hand-written sequence of `stop_sigil_seen` calls.
 */
const stopSigilsOf = (role: Role): readonly StopSigil[] =>
  STOP_SIGILS.filter((sigil) => (roleDescriptor(role).sigils as readonly string[]).includes(sigil));

/** The names of `role`'s secrets bound for `target`, in declaration order. */
export const secretsFor = (role: Role, target: SecretTarget): readonly RoleSecret[] =>
  roleDescriptor(role).secrets.named.filter((secret) => secret.targets.includes(target));

export interface RoleBehaviour {
  role: Role;
  /** Every sigil a session of this role may end with. */
  sigils: readonly Sigil[];
  /** Its terminal sigils alone, in `phase.ts`'s order. */
  stopSigils: readonly StopSigil[];
  recoveryPrompt: string;
  phases: boolean;
  phaseTicketProbe: boolean;
  hostLease: boolean;
  gateHolds: boolean;
  invariant: string;
  secretsManager: boolean;
  /** Secret names by target; a secret wanted by both appears in both. */
  iterationSecrets: readonly string[];
  gateSecrets: readonly string[];
  /** Every declared secret name, whatever its target — what the iteration's filter may have to strip. */
  allSecrets: readonly string[];
  /**
   * The secrets OTHER roles declare and this one does not.
   *
   * The manager injects the whole scope into every child, so a credential
   * another role acts with reaches this loop unless it is stripped by name:
   * without this list a coder would be handed the doctor's retry token by
   * `doppler run` alone, having declared nothing.
   */
  foreignSecrets: readonly string[];
  /** Check command per secret name; a secret with no checker yet maps to `''`. */
  checks: Readonly<Record<string, string>>;
  /** The orchestrator's extra settings file, harness-relative, or `''` for none. */
  orchestratorSettings: string;
}

export function roleBehaviour(role: Role): RoleBehaviour {
  const descriptor = roleDescriptor(role);
  const named = descriptor.secrets.named;
  return {
    role,
    sigils: descriptor.sigils,
    stopSigils: stopSigilsOf(role),
    recoveryPrompt: descriptor.recoveryPrompt,
    phases: descriptor.phases,
    phaseTicketProbe: descriptor.phaseTicketProbe,
    hostLease: descriptor.hostLease,
    gateHolds: descriptor.gateHolds,
    invariant: descriptor.invariant ?? "",
    secretsManager: descriptor.secrets.manager,
    iterationSecrets: secretsFor(role, "iteration").map((secret) => secret.name),
    gateSecrets: secretsFor(role, "gate").map((secret) => secret.name),
    allSecrets: named.map((secret) => secret.name),
    foreignSecrets: [
      ...new Set(
        ROLES.filter((other) => other !== role)
          .flatMap((other) => roleDescriptor(other).secrets.named.map((secret) => secret.name))
          .filter((name) => !named.some((secret) => secret.name === name)),
      ),
    ],
    checks: Object.fromEntries(named.map((secret) => [secret.name, secret.check ?? ""])),
    orchestratorSettings: descriptor.orchestratorSettings ?? "",
  };
}

/**
 * `roleBehaviour(role)` as `export` lines for a POSIX shell.
 *
 * Every value is quoted, including the recovery prompt, which carries the
 * sigil literals and would otherwise be a shell injection with the model's own
 * text in it.
 */
export function exportLines(role: Role): string[] {
  const behaviour = roleBehaviour(role);
  const flag = (value: boolean): string => (value ? "1" : "0");
  const lines = [
    `export RALPH_ROLE_SIGILS=${shellQuote(behaviour.sigils.join(" "))}`,
    `export RALPH_ROLE_STOP_SIGILS=${shellQuote(behaviour.stopSigils.join(" "))}`,
    `export RALPH_ROLE_RECOVERY_PROMPT=${shellQuote(behaviour.recoveryPrompt)}`,
    `export RALPH_ROLE_PHASES=${flag(behaviour.phases)}`,
    `export RALPH_ROLE_PHASE_TICKET_PROBE=${flag(behaviour.phaseTicketProbe)}`,
    `export RALPH_ROLE_HOST_LEASE=${flag(behaviour.hostLease)}`,
    `export RALPH_ROLE_GATE_HOLDS=${flag(behaviour.gateHolds)}`,
    `export RALPH_ROLE_INVARIANT=${shellQuote(behaviour.invariant)}`,
    `export RALPH_ROLE_SECRETS_MANAGER=${flag(behaviour.secretsManager)}`,
    `export RALPH_ROLE_SECRETS=${shellQuote(behaviour.allSecrets.join(" "))}`,
    `export RALPH_ROLE_SECRETS_ITERATION=${shellQuote(behaviour.iterationSecrets.join(" "))}`,
    `export RALPH_ROLE_SECRETS_GATE=${shellQuote(behaviour.gateSecrets.join(" "))}`,
    `export RALPH_ROLE_FOREIGN_SECRETS=${shellQuote(behaviour.foreignSecrets.join(" "))}`,
    // Exported empty for a role with none, never left unset: an unset name
    // would let a value from the operator's environment reach `ralph.sh`'s
    // `--settings` and rail a role the descriptor does not.
    `export RALPH_ROLE_ORCHESTRATOR_SETTINGS=${shellQuote(behaviour.orchestratorSettings)}`,
  ];
  for (const name of behaviour.allSecrets) {
    // The name is interpolated as-is on both sides, here and in `ralph.sh`'s
    // `${RALPH_ROLE_SECRET_CHECK_<name>}` read. Safe because `roles.test.ts`
    // fences every secret name to `^[A-Z][A-Z0-9_]*$`, which is already a legal
    // variable suffix; sanitising only here would hide a divergence.
    lines.push(`export RALPH_ROLE_SECRET_CHECK_${name}=${shellQuote(behaviour.checks[name] ?? "")}`);
  }
  return lines;
}

function main(argv: string[]): number {
  const [mode, role] = argv;
  if ((mode !== "--export" && mode !== "--json") || role === undefined) {
    console.error(`usage: bun role-behaviour.ts --export|--json <${ROLES.join("|")}>`);
    return 2;
  }
  if (!isRole(role)) {
    console.error(`role-behaviour: '${role}' is not a role (${ROLES.join(", ")})`);
    return 1;
  }
  console.log(mode === "--json" ? JSON.stringify(roleBehaviour(role), null, 2) : exportLines(role).join("\n"));
  return 0;
}

if (import.meta.main) {
  // exitCode, not exit(): see models.ts — exiting at once truncates piped stdout.
  process.exitCode = main(process.argv.slice(2));
}
