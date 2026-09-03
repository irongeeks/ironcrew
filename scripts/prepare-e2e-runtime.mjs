#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const runtimeDir = path.resolve(process.cwd(), ".tmp", "e2e-runtime");
const logsDir = path.join(runtimeDir, "logs");
const dbPath = path.join(runtimeDir, "octooffice.e2e.sqlite");

fs.mkdirSync(runtimeDir, { recursive: true });

for (const suffix of ["", "-wal", "-shm"]) {
  const target = `${dbPath}${suffix}`;
  if (!fs.existsSync(target)) continue;
  fs.rmSync(target, { force: true });
}

fs.rmSync(logsDir, { recursive: true, force: true });
fs.mkdirSync(logsDir, { recursive: true });

console.log(`[e2e] prepared isolated runtime`);
console.log(`[e2e] DB_PATH=${dbPath}`);
console.log(`[e2e] LOGS_DIR=${logsDir}`);
