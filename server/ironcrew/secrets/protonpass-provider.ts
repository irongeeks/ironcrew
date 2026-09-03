/**
 * IronCrew — Proton Pass SecretProvider.
 *
 * Wraps the official `pass-cli` (https://github.com/protonpass/pass-cli,
 * docs at https://protonpass.github.io/pass-cli/). Retrieval goes through
 * `pass-cli item view --share-id <id> --item-id <id> --field <name> --output
 * json`: share/item IDs rather than the human-readable `pass://Vault/Item`
 * shorthand some docs also show, so a later rename in the vault cannot
 * silently break a stored ref. Headless auth is
 * `PROTON_PASS_PERSONAL_ACCESS_TOKEN` + `pass-cli login` (done once, out of
 * band, by whoever operates this install) plus a filesystem-backed key
 * provider (`PROTON_PASS_KEY_PROVIDER=fs`) for a container-friendly deploy —
 * both are environment concerns, not something this class does on the
 * caller's behalf.
 *
 * `--output json`'s exact field-selection shape is not fully pinned down by
 * the docs fetched for this integration, so `extractFieldValue` below is
 * deliberately defensive about where the value can be found in the parsed
 * object. Verify against a real `pass-cli` install before relying on this
 * in production — none is installed in this environment. Everything past
 * the CLI boundary follows this project's established CliAdapterRuntime
 * pattern (argv-array spawning, timeouts, dependency-injected runner).
 */

import { type CliRunner, spawnCliRunner } from "./run-cli.ts";
import { SecretResolutionError, type SecretConnectionStatus, type SecretProvider } from "./secret-provider.ts";
import type { SecretRef } from "./secret-ref.ts";

export interface ProtonPassSecretProviderOptions {
  /** Path to the `pass-cli` binary. Defaults to "pass-cli" (resolved via PATH). */
  passCliPath?: string;
  timeoutMs?: number;
  run?: CliRunner;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Best-effort extraction of one field's value out of `pass-cli item view
 * --output json`'s parsed result, across the plausible shapes a versioned
 * CLI output could take. Returns null rather than guessing when nothing
 * matches, so the caller can fail loudly instead of returning junk.
 */
export function extractFieldValue(parsed: unknown, field: string): string | null {
  if (typeof parsed === "string") return parsed;
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;

  const direct = obj[field];
  if (typeof direct === "string") return direct;

  const nested = obj.fields;
  if (nested && typeof nested === "object") {
    const v = (nested as Record<string, unknown>)[field];
    if (typeof v === "string") return v;
  }

  if (field === "password" && typeof obj.value === "string") return obj.value;
  if (typeof obj.value === "string" && Object.keys(obj).length <= 2) return obj.value;

  return null;
}

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
      [
        this.passCliPath,
        "item",
        "view",
        "--share-id",
        shareId,
        "--item-id",
        itemId,
        "--field",
        field,
        "--output",
        "json",
      ],
      { timeoutMs: this.timeoutMs },
    );
    if (res.code !== 0) {
      throw new SecretResolutionError(
        `Proton Pass: could not resolve item "${ref.itemRef}" (${field}) — ${res.stderr.trim() || "unknown error"}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(res.stdout);
    } catch {
      throw new SecretResolutionError(`Proton Pass: could not parse "pass-cli item view" JSON output.`);
    }
    const value = extractFieldValue(parsed, field);
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
