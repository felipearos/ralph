/**
 * An in-memory `SecretSource` for tests: answers what it was seeded with, can
 * be told a different answer mid-test (a keyring unlocking, a token being
 * stored), and logs every name it was asked for, so a test can assert that a
 * secret was — or was not — read again.
 */
import type { SecretRead, SecretSource } from "./source";

export interface FakeSecretSource extends SecretSource {
  /** Every name read, in order, repeats included. */
  readonly reads: string[];
  /** Answer `read` for `name` from now on. */
  set(name: string, read: SecretRead): void;
}

/** A name the seed does not mention reads as absent, as an unstored secret does. */
export function createFakeSecretSource(seed: Record<string, SecretRead> = {}): FakeSecretSource {
  const answers = new Map<string, SecretRead>(Object.entries(structuredClone(seed)));
  const reads: string[] = [];
  return {
    kind: "fake",
    reads,
    set(name, read) {
      answers.set(name, structuredClone(read));
    },
    async read(name) {
      reads.push(name);
      return structuredClone(answers.get(name) ?? { kind: "absent" });
    },
  };
}
