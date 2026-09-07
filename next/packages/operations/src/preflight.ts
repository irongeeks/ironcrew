import { statfs, access } from "node:fs/promises";
import { constants } from "node:fs";
import { createServer } from "node:net";
import { execFile } from "node:child_process";
import path from "node:path";
import { OperationError } from "./common.ts";
import { assertSupportedHost, detectHostPlatform } from "./host-platform.ts";
export async function checkPrivateRuntime(executable: string): Promise<void> {
  const version = await new Promise<string>((resolve, reject) =>
    execFile(executable, ["--version"], { env: {}, timeout: 15000, maxBuffer: 1024 }, (error, stdout) =>
      error
        ? reject(new OperationError("runtime", "Private Node-Runtime kann nicht gestartet werden."))
        : resolve(stdout.trim()),
    ),
  );
  if (version !== "v26.4.0") throw new OperationError("runtime_version", "Die private Runtime muss Node 26.4.0 sein.");
}
export async function preflightInstallation(options: {
  programParent: string;
  dataParent: string;
  requiredBytes: number;
  port?: number;
  checkPort?: boolean;
  platform?: string;
  arch?: string;
}): Promise<{ platform: string; arch: string; freeBytes: number; port: number; osVersion: string }> {
  const platform = options.platform ?? process.platform,
    arch = options.arch ?? process.arch;
  const host = await detectHostPlatform();
  if (host.platform !== platform || host.arch !== arch)
    throw new OperationError("platform", "Vorprüfung muss auf dem tatsächlichen Zielhost laufen.");
  assertSupportedHost(host);
  if (!Number.isSafeInteger(options.requiredBytes) || options.requiredBytes < 0)
    throw new OperationError("size", "Ungültiger Platzbedarf.");
  for (const directory of [options.programParent, options.dataParent]) {
    if (!path.isAbsolute(directory)) throw new OperationError("path", "Installationspfade müssen absolut sein.");
    try {
      await access(directory, constants.W_OK);
    } catch {
      throw new OperationError("permissions", "Keine Schreibrechte auf Installations- oder Datenverzeichnis.");
    }
  }
  const spaces = await Promise.all([statfs(options.programParent), statfs(options.dataParent)]);
  const freeBytes = Math.min(...spaces.map((space) => space.bavail * space.bsize));
  if (freeBytes < options.requiredBytes + 64 * 1024 * 1024)
    throw new OperationError("disk_space", "Nicht genügend freier Speicher für Staging und Rückweg.");
  const port = options.port ?? 8790;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new OperationError("port", "Ungültiger Port.");
  if (options.checkPort !== false)
    await new Promise<void>((resolve, reject) => {
      const server = createServer();
      server.once("error", () => reject(new OperationError("port_busy", "Der gewünschte Dienstport ist belegt.")));
      server.listen(port, "127.0.0.1", () => server.close(() => resolve()));
    });
  return { platform, arch, freeBytes, port, osVersion: host.version };
}
