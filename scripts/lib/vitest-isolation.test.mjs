import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

it("independent Vitest processes with the same worker ID keep separate databases and logs", () => {
  const runtimes = [];
  const launch = () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        'await import("./server/test/setup.ts"); console.log(JSON.stringify({db: process.env.DB_PATH, logs: process.env.LOGS_DIR}));',
      ],
      { cwd: root, env: { ...process.env, VITEST_WORKER_ID: "1" }, encoding: "utf8", timeout: 15_000 },
    );
    expect(result.status).toBe(0);
    const runtime = JSON.parse(result.stdout.trim());
    runtimes.push(runtime);
    return runtime;
  };
  try {
    const first = launch();
    fs.writeFileSync(first.db, "first suite data");
    const second = launch();
    expect(second.db).not.toBe(first.db);
    expect(second.logs).not.toBe(first.logs);
    expect(fs.readFileSync(first.db, "utf8")).toBe("first suite data");
  } finally {
    for (const runtime of runtimes) {
      fs.rmSync(runtime.db, { force: true });
      fs.rmSync(runtime.logs, { force: true, recursive: true });
    }
  }
});
