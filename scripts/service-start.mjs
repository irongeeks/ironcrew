#!/usr/bin/env node
/** Shared launchd/systemd entrypoint. dotenv parsing never evaluates shell code. */
import { lstatSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
const [envFile, role] = process.argv.slice(2);
if (!envFile || !path.isAbsolute(envFile) || !["control", "runner"].includes(role))
  throw new Error("Expected absolute environment file and control/runner role.");
const info = lstatSync(envFile);
if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid()) {
  throw new Error("Service configuration must be an owned regular file with mode 0600.");
}
process.loadEnvFile(envFile);
process.env.NODE_ENV = "production";
process.env.IRONCREW_INSTALL_TYPE = "native";
const requiredKey = role === "runner" ? "IRONCREW_RUNNER_TOKEN" : "OAUTH_ENCRYPTION_SECRET";
const configured = process.env[requiredKey];
if (!configured || configured.includes("__CHANGE_ME__") || configured.length < 32) {
  throw new Error(`Configure ${requiredKey} with a unique value of at least 32 characters before starting.`);
}
const prefix = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const child = spawn(
  process.execPath,
  ["--import", "tsx", role === "runner" ? "server/runner-main.ts" : "server/index.ts"],
  {
    cwd: prefix,
    env: process.env,
    stdio: "inherit",
  },
);
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
child.on("error", () => {
  console.error("IronCrew service process failed to start.");
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
