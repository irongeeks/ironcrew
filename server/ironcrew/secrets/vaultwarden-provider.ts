/**
 * IronCrew — Vaultwarden SecretProvider.
 *
 * Vaultwarden is a self-hosted, Bitwarden-protocol-compatible server; it
 * does not implement Bitwarden's separate "Secrets Manager" product (the
 * `bws` CLI), only the standard client API the official `bw` CLI speaks.
 * That is the integration path here: `bw` pointed at the self-hosted
 * instance via `bw config server <url>`, authenticated non-interactively
 * with an API key (`bw login --apikey`, using the `BW_CLIENTID`/
 * `BW_CLIENTSECRET` env vars `bw` itself reads), then unlocked
 * (`bw unlock --passwordenv BW_PASSWORD`) to obtain a session key used for
 * every subsequent `bw get`.
 *
 * `bw`'s exact flags are stable and well-documented, but this class has not
 * been exercised against a real `bw` binary in this environment (none is
 * installed here) — verify against a real Vaultwarden instance before
 * relying on it in production. Everything past the CLI boundary (argv-array
 * spawning, timeouts, dependency-injected runner for tests) follows this
 * project's established CliAdapterRuntime pattern.
 */

import { type CliRunner, spawnCliRunner } from "./run-cli.ts";
import { SecretResolutionError, type SecretConnectionStatus, type SecretProvider } from "./secret-provider.ts";
import type { SecretRef } from "./secret-ref.ts";

export interface VaultwardenSecretProviderOptions {
  /** Path to the `bw` binary. Defaults to "bw" (resolved via PATH). */
  bwPath?: string;
  /** Self-hosted Vaultwarden URL, e.g. "https://vault.example.com". Required for config/login to make sense. */
  serverUrl?: string;
  timeoutMs?: number;
  run?: CliRunner;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export class VaultwardenSecretProvider implements SecretProvider {
  readonly kind = "vaultwarden" as const;

  private readonly bwPath: string;
  private readonly serverUrl: string;
  private readonly timeoutMs: number;
  private readonly run: CliRunner;
  private configuredServer = false;
  private cachedSession: string | null = null;

  constructor(opts: VaultwardenSecretProviderOptions = {}) {
    this.bwPath = opts.bwPath ?? "bw";
    this.serverUrl = opts.serverUrl ?? "";
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.run = opts.run ?? spawnCliRunner;
  }

  private async ensureServerConfigured(): Promise<void> {
    if (this.configuredServer || !this.serverUrl) return;
    await this.run([this.bwPath, "config", "server", this.serverUrl], { timeoutMs: this.timeoutMs });
    this.configuredServer = true;
  }

  /**
   * A session key handed back by `bw unlock --raw`. Cached in-process for
   * reuse across resolutions in the same run — cheaper than unlocking on
   * every call — but never persisted: a restart re-unlocks.
   */
  private async session(): Promise<string> {
    if (process.env.BW_SESSION) return process.env.BW_SESSION;
    if (this.cachedSession) return this.cachedSession;

    await this.ensureServerConfigured();

    if (!process.env.BW_PASSWORD) {
      throw new SecretResolutionError(
        "Vaultwarden: set BW_SESSION (already-unlocked) or BW_PASSWORD (for non-interactive unlock) in the environment.",
      );
    }
    const res = await this.run([this.bwPath, "unlock", "--raw", "--passwordenv", "BW_PASSWORD"], {
      timeoutMs: this.timeoutMs,
    });
    const session = res.stdout.trim();
    if (res.code !== 0 || !session) {
      throw new SecretResolutionError(`Vaultwarden: unlock failed — ${res.stderr.trim() || "unknown error"}`);
    }
    this.cachedSession = session;
    return session;
  }

  async resolve(ref: SecretRef): Promise<string> {
    if (ref.provider !== "vaultwarden") {
      throw new SecretResolutionError(`VaultwardenSecretProvider cannot resolve a "${ref.provider}" ref.`);
    }
    if (!ref.itemRef.trim()) throw new SecretResolutionError("Vaultwarden: itemRef must not be empty.");

    const session = await this.session();
    // `bw get <object> <item>` — object defaults to "password", the common
    // case; callers can ask for "username", "notes", "uri", "totp", etc.
    const field = ref.field ?? "password";
    const res = await this.run([this.bwPath, "get", field, ref.itemRef, "--session", session], {
      timeoutMs: this.timeoutMs,
    });
    if (res.code !== 0) {
      throw new SecretResolutionError(
        `Vaultwarden: could not resolve "${ref.itemRef}" (${field}) — ${res.stderr.trim() || "unknown error"}`,
      );
    }
    const value = res.stdout.trim();
    if (!value) {
      throw new SecretResolutionError(`Vaultwarden: item "${ref.itemRef}" has no value for field "${field}".`);
    }
    return value;
  }

  async testConnection(): Promise<SecretConnectionStatus> {
    try {
      await this.ensureServerConfigured();
      const res = await this.run([this.bwPath, "status"], { timeoutMs: this.timeoutMs });
      if (res.code !== 0) {
        return { ok: false, message: res.stderr.trim() || "bw status failed to run." };
      }
      // `bw status` prints JSON: {"serverUrl":"...","lastSync":"...","userEmail":"...","status":"unlocked"|"locked"|"unauthenticated"}
      let status = "";
      try {
        status = String((JSON.parse(res.stdout) as { status?: string }).status ?? "");
      } catch {
        // Fall through with the raw text below — still informative.
      }
      if (status === "unlocked" || status === "locked") {
        return { ok: true, message: `bw status: ${status}` };
      }
      return { ok: false, message: status ? `bw status: ${status}` : res.stdout.trim() || "unrecognised bw status" };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }
}
