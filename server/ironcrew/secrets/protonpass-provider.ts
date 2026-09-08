/**
 * IronCrew — Proton Pass SecretProvider.
 *
 * Wraps the official `pass-cli` (https://github.com/protonpass/pass-cli,
 * docs at https://protonpass.github.io/pass-cli/). Retrieval goes through
 * `pass-cli item view --share-id=<id> --item-id=<id> --field=<name>`: share/item IDs rather than the human-readable `pass://Vault/Item`
 * shorthand some docs also show, so a later rename in the vault cannot
 * silently break a stored ref. Headless auth is
 * `PROTON_PASS_PERSONAL_ACCESS_TOKEN` + `pass-cli login` (done once, out of
 * band, by whoever operates this install) plus a filesystem-backed key
 * provider (`PROTON_PASS_KEY_PROVIDER=fs`) for a container-friendly deploy —
 * both are environment concerns, not something this class does on the
 * caller's behalf.
 *
 * Field selection returns plaintext. Preserve its literal value, removing
 * only the single LF added by the CLI (Rust println! uses LF on all platforms). Use argv-array spawning,
 * timeouts and the dependency-injected runner at the CLI boundary.
 */

import { type CliRunner, spawnCliRunner } from "../shared/cli-runner.ts";
import { SecretResolutionError, type SecretConnectionStatus, type SecretProvider } from "./secret-provider.ts";
import type { SecretRef } from "./secret-ref.ts";

export interface ProtonPassSecretProviderOptions {
  /** Path to the `pass-cli` binary. Defaults to "pass-cli" (resolved via PATH). */
  passCliPath?: string;
  timeoutMs?: number;
  run?: CliRunner;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export class ProtonPassSecretProvider implements SecretProvider {
  readonly kind = "protonpass" as const;

  private readonly passCliPath: string;
  private readonly timeoutMs: number;
  private readonly run: CliRunner;

  constructor(opts: ProtonPassSecretProviderOptions = {}) {
    this.passCliPath = opts.passCliPath ?? "pass-cli";
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.run = opts.run ?? spawnCliRunner;
  }

  async resolve(ref: SecretRef): Promise<string> {
    if (ref.provider !== "protonpass") {
      throw new SecretResolutionError(`ProtonPassSecretProvider cannot resolve a "${ref.provider}" ref.`);
    }
    const [shareId, itemId] = ref.itemRef.split(":");
    if (!shareId || !itemId) {
      throw new SecretResolutionError(`Proton Pass: itemRef must be "<shareId>:<itemId>", got "${ref.itemRef}".`);
    }
    const field = ref.field ?? "password";
    const res = await this.run(
      [this.passCliPath, "item", "view", `--share-id=${shareId}`, `--item-id=${itemId}`, `--field=${field}`],
      { timeoutMs: this.timeoutMs },
    );
    if (res.code !== 0) {
      throw new SecretResolutionError("Proton Pass: could not resolve field. Check the CLI session and permissions.");
    }

    const value = res.stdout.replace(/\n$/, "");
    if (!value) {
      throw new SecretResolutionError(`Proton Pass: item "${ref.itemRef}" has no value for field "${field}".`);
    }
    return value;
  }

  async testConnection(): Promise<SecretConnectionStatus> {
    try {
      const res = await this.run([this.passCliPath, "info"], { timeoutMs: this.timeoutMs });
      if (res.code !== 0) {
        return { ok: false, message: res.stderr.trim() || "pass-cli info failed." };
      }
      return { ok: true, message: res.stdout.trim() || "authenticated" };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }
}
