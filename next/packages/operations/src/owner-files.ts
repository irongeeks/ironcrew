import path from "node:path";
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { OperationError } from "./common.ts";
import type { UpdaterConfiguration } from "./updater.ts";
export async function ownerFile(config: UpdaterConfiguration, request: Record<string, unknown>): Promise<unknown> {
  const owner = await stat(config.dataDirectory);
  return new Promise((resolve, reject) => {
    const child = execFile(
      path.join(config.bootstrapDirectory, process.platform === "win32" ? "runtime/node.exe" : "runtime/node"),
      [path.join(config.bootstrapDirectory, "dist/apps/updater/files.js")],
      {
        cwd: config.bootstrapDirectory,
        ...(process.platform !== "win32" && process.getuid?.() === 0 ? { uid: owner.uid, gid: owner.gid } : {}),
        env: { LANG: "C", TZ: "UTC" },
        timeout: 30000,
        maxBuffer: 2_000_000,
      },
      (error, stdout) => {
        if (error)
          return reject(new OperationError("owner_file_failed", "Dateihelfer unter Dienstidentität fehlgeschlagen."));
        try {
          const response = JSON.parse(stdout);
          if (response.error)
            reject(new OperationError(response.error.code, "Dateioperation unter Dienstidentität wurde abgelehnt."));
          else resolve(response.result);
        } catch {
          reject(new OperationError("owner_file_failed", "Ungültige Dateihelferantwort."));
        }
      },
    );
    child.stdin!.end(JSON.stringify({ ...request, dataDirectory: config.dataDirectory }));
  });
}
