import fs from "node:fs";
import path from "node:path";

process.env.NODE_ENV = "test";

// Worker IDs restart at 1 in each Vitest invocation. Include the process so
// simultaneous local/agent suites cannot reset each other's SQLite databases.
const workerSuffix = `${process.pid}-${process.env.VITEST_WORKER_ID || "main"}`;
const runtimeDir = path.resolve(process.cwd(), ".tmp", "vitest-runtime");
const dbPath = path.join(runtimeDir, `ironcrew.vitest.${workerSuffix}.sqlite`);
const logsDir = path.join(runtimeDir, `logs-${workerSuffix}`);

try {
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
} catch {
  // ignore setup filesystem errors; tests will surface runtime issues
}

process.env.DB_PATH = dbPath;
process.env.LOGS_DIR = logsDir;

// Anything encrypted at rest (OAuth tokens, mailbox credentials) needs a key.
// server/oauth/helpers.ts captures this at import time, so it has to be set
// here in setupFiles — before any test module imports it. `||=` keeps an
// externally supplied value; the tests that assert the *absence* of a key
// manage the variable themselves (server/test/oauth/helpers.test.ts).
process.env.OAUTH_ENCRYPTION_SECRET ||= "0".repeat(64);
