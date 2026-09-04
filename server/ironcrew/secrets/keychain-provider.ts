/**
 * IronCrew — the operating system's own keychain as a SecretProvider.
 *
 * The third vault, alongside Vaultwarden and Proton Pass, and the one with
 * the narrowest correct use. It is the right default on a workstation: the
 * secret is already protected by the login the operator performs anyway, and
 * nothing extra has to run or be configured.
 *
 * IT IS THE WRONG CHOICE ON A HEADLESS SERVER
 *
 * libsecret needs a running daemon and an unlocked collection. A service
 * starting at boot has neither, so a keychain ref there resolves to a failure
 * at the worst possible moment — during a run, not during configuration.
 * `testConnection()` therefore probes the daemon rather than assuming it, so
 * the Settings UI says so before anyone depends on it. A server should use
 * Vaultwarden or Proton Pass; both authenticate non-interactively by design.
 *
 * TWO PLATFORMS, ONE SHAPE
 *
 *   Linux   `secret-tool lookup <attr> <value>` (libsecret)
 *   macOS   `security find-generic-password -w -s <service> [-a <account>]`
 *
 * Both print the secret on stdout and nothing else, which is why the ref
 * format below is "service" or "service:account" rather than a path: it is
 * what both tools actually take.
 *
 * Everything past the CLI boundary follows the pattern the other two
 * providers use — argv arrays never shell strings, an injected runner so
 * tests exercise the real code path without a keychain, and a timeout.
 */

import { type CliRunner, spawnCliRunner } from "../shared/cli-runner.ts";
import { SecretResolutionError, type SecretConnectionStatus, type SecretProvider } from "./secret-provider.ts";
import type { SecretRef } from "./secret-ref.ts";

const DEFAULT_TIMEOUT_MS = 10_000;

/** The attribute `secret-tool` stores IronCrew's entries under. */
export const KEYCHAIN_SERVICE_ATTRIBUTE = "service";

export interface KeychainSecretProviderOptions {
  /** "linux" (libsecret) or "darwin" (security). Defaults to the running platform. */
  platform?: NodeJS.Platform;
  /** Binary path; defaults to `secret-tool` or `security` per platform. */
  binaryPath?: string;
  timeoutMs?: number;
  run?: CliRunner;
}

/**
 * Splits "service" or "service:account" into its parts.
 *
 * Exported because the format is the thing an operator types into the
 * Settings UI, and a wrong split is the failure they would otherwise only
 * discover mid-run.
 */
export function parseKeychainRef(itemRef: string): { service: string; account: string | null } {
  const trimmed = (itemRef ?? "").trim();
  if (trimmed === "")
    throw new SecretResolutionError("Keychain-Ref ist leer; erwartet wird 'dienst' oder 'dienst:konto'.");

  const separator = trimmed.indexOf(":");
  if (separator < 0) return { service: trimmed, account: null };

  const service = trimmed.slice(0, separator).trim();
  const account = trimmed.slice(separator + 1).trim();
  if (service === "" || account === "") {
    throw new SecretResolutionError(`Keychain-Ref "${itemRef}" ist unvollständig; erwartet wird 'dienst:konto'.`);
  }
  return { service, account };
}

export class KeychainSecretProvider implements SecretProvider {
  readonly kind = "keychain" as const;

  private readonly platform: NodeJS.Platform;
  private readonly binaryPath: string;
  private readonly timeoutMs: number;
  private readonly run: CliRunner;

  constructor(opts: KeychainSecretProviderOptions = {}) {
    this.platform = opts.platform ?? process.platform;
    this.binaryPath = opts.binaryPath ?? (this.platform === "darwin" ? "security" : "secret-tool");
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.run = opts.run ?? spawnCliRunner;
  }

  private argvFor(ref: { service: string; account: string | null }): string[] {
    if (this.platform === "darwin") {
      const argv = [this.binaryPath, "find-generic-password", "-w", "-s", ref.service];
      if (ref.account) argv.push("-a", ref.account);
      return argv;
    }
    const argv = [this.binaryPath, "lookup", KEYCHAIN_SERVICE_ATTRIBUTE, ref.service];
    if (ref.account) argv.push("account", ref.account);
    return argv;
  }

  async resolve(ref: SecretRef): Promise<string> {
    if (this.platform !== "darwin" && this.platform !== "linux") {
      throw new SecretResolutionError(
        `Der OS-Schlüsselbund wird auf "${this.platform}" nicht unterstützt; nutze Vaultwarden oder Proton Pass.`,
      );
    }

    const parsed = parseKeychainRef(ref.itemRef);
    let result;
    try {
      result = await this.run(this.argvFor(parsed), { timeoutMs: this.timeoutMs });
    } catch (err) {
      // The message names the binary, not the item: an operator whose
      // secret-tool is missing needs to know that, and the item name is the
      // one part of this that might hint at what the secret is for.
      throw new SecretResolutionError(
        `"${this.binaryPath}" konnte nicht ausgeführt werden: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (result.code !== 0) {
      // stderr deliberately not echoed: on some platforms a failed lookup
      // prints the query back, and the query is a locator an operator chose.
      throw new SecretResolutionError(
        `Kein Eintrag für "${parsed.service}"${parsed.account ? ` / "${parsed.account}"` : ""} im Schlüsselbund.`,
      );
    }

    // secret-tool prints the value with no trailing newline; `security -w`
    // adds one. Trimming only the line ending keeps a secret that genuinely
    // ends in spaces intact.
    const value = result.stdout.replace(/\r?\n$/, "");
    if (value === "") {
      throw new SecretResolutionError(`Der Schlüsselbund-Eintrag "${parsed.service}" ist leer.`);
    }
    return value;
  }

  /**
   * Probes the keychain without needing a real item.
   *
   * On Linux this is where a headless server finds out: no session bus, no
   * unlocked collection, and the answer says so in words an operator can act
   * on rather than failing later inside a run.
   */
  async testConnection(): Promise<SecretConnectionStatus> {
    if (this.platform !== "darwin" && this.platform !== "linux") {
      return { ok: false, message: `Kein Schlüsselbund-Zugriff auf "${this.platform}".` };
    }

    try {
      const result = await this.run([this.binaryPath, this.platform === "darwin" ? "help" : "--version"], {
        timeoutMs: this.timeoutMs,
      });
      // `security help` exits non-zero on some macOS versions while still
      // proving the binary exists, so presence is judged by it running at all.
      if (result.code === null) {
        return { ok: false, message: `"${this.binaryPath}" wurde beendet, ohne einen Status zu liefern.` };
      }

      if (this.platform === "linux" && !process.env.DBUS_SESSION_BUS_ADDRESS) {
        return {
          ok: false,
          message:
            "Kein DBus-Session-Bus — auf einem Dienst ohne Desktop-Sitzung ist der Schlüsselbund nicht erreichbar. " +
            "Nutze auf einem Server Vaultwarden oder Proton Pass.",
        };
      }
      return { ok: true, message: `${this.binaryPath} verfügbar.` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }
}
