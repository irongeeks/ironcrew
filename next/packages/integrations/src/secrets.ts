import { execFile } from "node:child_process";
import path from "node:path";
import { z } from "zod";
import { IntegrationError } from "./transport.ts";

export const secretRefSchema = z
  .object({
    provider: z.literal("proton-pass"),
    shareId: z.string().min(1).max(300),
    itemId: z.string().min(1).max(300),
    field: z.string().min(1).max(200),
  })
  .strict();
export type SecretRef = z.infer<typeof secretRefSchema>;
export interface SecretResolver {
  resolve(ref: SecretRef, reason: string): Promise<string>;
}
export const PROTON_PASS_MIN_VERSION = "2.3.2";

function supportsProtonPassVersion(output: string): boolean {
  // Official releases include the product name and may include a Git revision.
  // Accept only complete stable versions, never prereleases or unrelated output.
  const match =
    /^(?:(?:Proton Pass CLI|pass-cli)[ \t]+)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[ \t]+\([0-9a-f]{7,40}\))?$/i.exec(
      output.trim(),
    );
  if (!match) return false;
  const version = match.slice(1, 4).map(Number);
  if (!version.every(Number.isSafeInteger)) return false;
  const minimum = PROTON_PASS_MIN_VERSION.split(".").map(Number);
  for (let index = 0; index < minimum.length; index++) {
    if (version[index] !== minimum[index]) return version[index]! > minimum[index]!;
  }
  return true;
}
export type SecretCliRunner = (
  executable: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number },
) => Promise<string>;
const runCli: SecretCliRunner = (executable, args, options) =>
  new Promise((resolve, reject) => {
    execFile(executable, args, options, (error, stdout) =>
      error
        ? reject(new IntegrationError("auth", "Proton-Pass-Zugriff fehlgeschlagen. Sitzung, Ablauf und Rechte prüfen."))
        : resolve(stdout),
    );
  });
/** Dedicated broker only. The supplied environment is explicit and never extends process.env. */
export class ProtonPassResolver implements SecretResolver {
  private readonly environment: NodeJS.ProcessEnv;
  private readonly run: SecretCliRunner;
  private readonly options: {
    executable: string;
    environment: NodeJS.ProcessEnv;
    run?: SecretCliRunner;
  };
  constructor(options: { executable: string; environment: NodeJS.ProcessEnv; run?: SecretCliRunner }) {
    this.options = options;
    if (!path.isAbsolute(options.executable))
      throw new IntegrationError(
        "configuration",
        "pass-cli benötigt einen absoluten administrativ konfigurierten Pfad.",
      );
    const allowed = new Set([
      "HOME",
      "USERPROFILE",
      "APPDATA",
      "LOCALAPPDATA",
      "SYSTEMROOT",
      "PATH",
      "PROTON_PASS_SESSION_DIR",
      "PROTON_PASS_KEY_PROVIDER",
      "PROTON_PASS_PERSONAL_ACCESS_TOKEN",
    ]);
    this.environment = Object.fromEntries(Object.entries(options.environment).filter(([key]) => allowed.has(key)));
    this.run = options.run ?? runCli;
  }
  async resolve(input: SecretRef, reason: string): Promise<string> {
    const ref = secretRefSchema.parse(input);
    if (!reason.trim() || reason.length > 300)
      throw new IntegrationError("validation", "Secretzugriff benötigt einen Grund mit höchstens 300 Zeichen.");
    const options = {
      env: { ...this.environment, PROTON_PASS_AGENT_REASON: reason },
      timeout: 15000,
      maxBuffer: 64 * 1024,
    };
    try {
      const version = await this.run(this.options.executable, ["--version"], options);
      if (!supportsProtonPassVersion(version))
        throw new IntegrationError(
          "configuration",
          `pass-cli ab Version ${PROTON_PASS_MIN_VERSION} ist erforderlich (stabile Version).`,
        );
      // The upstream implementation prints the selected field as plain text, even with --output json.
      // Bind values to their options so clap cannot interpret leading hyphens as new flags.
      const output = await this.run(
        this.options.executable,
        ["item", "view", `--share-id=${ref.shareId}`, `--item-id=${ref.itemId}`, `--field=${ref.field}`],
        options,
      );
      const value = output.replace(/\r?\n$/, "");
      if (!value) throw new IntegrationError("auth", "Proton-Pass-Feld ist leer oder nicht zugänglich.");
      return value;
    } catch (error) {
      if (error instanceof IntegrationError && error.code === "configuration") throw error;
      throw new IntegrationError("auth", "Proton-Pass-Zugriff fehlgeschlagen. Sitzung, Ablauf und Rechte prüfen.");
    }
  }
}
