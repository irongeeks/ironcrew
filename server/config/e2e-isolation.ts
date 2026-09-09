import fs from "node:fs";
import path from "node:path";

export const E2E_API_PORT = 8791;
export const E2E_WEB_PORT = 8810;
export const E2E_BASE_URL = `http://127.0.0.1:${E2E_WEB_PORT}`;
export const E2E_API_URL = `http://127.0.0.1:${E2E_API_PORT}`;

export function e2ePaths(runId: string, cwd = process.cwd()) {
  if (!/^[a-f0-9]{32}$/.test(runId)) throw new Error("E2E requires a fresh 32-character run ID");
  const runtimeDir = path.resolve(cwd, ".tmp", "e2e-runtime", runId);
  return { runtimeDir, dbPath: path.join(runtimeDir, "ironcrew.e2e.sqlite"), logsDir: path.join(runtimeDir, "logs") };
}

/** Never follow a scratch-directory or database symlink into operator data. */
export function assertE2EPathsSafe(runId: string, cwd = process.cwd()): void {
  const { runtimeDir, dbPath, logsDir } = e2ePaths(runId, cwd);
  for (const target of [
    path.resolve(cwd, ".tmp"),
    path.dirname(runtimeDir),
    runtimeDir,
    path.join(runtimeDir, "community-packs"),
    dbPath,
    `${dbPath}-wal`,
    `${dbPath}-shm`,
    logsDir,
  ]) {
    try {
      if (fs.lstatSync(target).isSymbolicLink()) throw new Error(`E2E refuses symlink: ${target}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/** Runs before the application opens SQLite or installs integrations. */
export function assertE2EIsolation(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): void {
  if (env.IRONCREW_E2E !== "1" && !env.IRONCREW_E2E_RUN_ID) return;
  if (env.IRONCREW_E2E !== "1") throw new Error("E2E run ID requires isolated mode");
  const runId = env.IRONCREW_E2E_RUN_ID ?? "";
  const { dbPath, logsDir } = e2ePaths(runId, cwd);
  if (
    env.HOST !== "127.0.0.1" ||
    env.PORT !== String(E2E_API_PORT) ||
    env.DB_PATH !== dbPath ||
    env.LOGS_DIR !== logsDir
  ) {
    throw new Error("E2E isolation refused: expected dedicated loopback port and run-specific scratch DB/log paths");
  }
  assertE2EPathsSafe(runId, cwd);
}

export function e2eReadyPath(runId: string): string {
  e2ePaths(runId);
  return `/api/e2e-ready/${runId}`;
}
