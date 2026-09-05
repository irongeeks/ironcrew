/**
 * The rename from OctoOffice must not lose somebody's company.
 *
 * An installation older than the rename keeps everything — tasks, decisions,
 * approvals, the whole audit chain — in `octooffice.sqlite`. If the default
 * path had simply been renamed, the service would have started cleanly,
 * created an empty `ironcrew.sqlite` beside it, and shown an empty company.
 * No error, no warning, nothing to notice until somebody went looking for
 * last week's work.
 *
 * These tests run the real resolver in a child process, because the default
 * is computed once at module load from `process.cwd()` — which is exactly how
 * it behaves in production, and which a same-process test would have to fake.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const runtimeModule = path.join(here, "runtime.ts");

let workdir: string;

beforeEach(() => {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), "ironcrew-dbpath-"));
});

afterEach(() => fs.rmSync(workdir, { recursive: true, force: true }));

/** Resolves DEFAULT_DB_PATH with `cwd` as the working directory. */
function resolveIn(cwd: string): { path: string; warned: boolean } {
  const script = `import { DEFAULT_DB_PATH } from ${JSON.stringify(runtimeModule)};
console.log("RESOLVED:" + DEFAULT_DB_PATH);`;
  const scriptPath = path.join(workdir, "probe.mjs");
  fs.writeFileSync(scriptPath, script);
  // Resolve the installed loader once; invoking npx from a temp directory may
  // download a package and the tsx CLI unnecessarily requires an IPC socket.
  const out = execFileSync(
    process.execPath,
    ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href, scriptPath],
    {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      // The .env loader and module graph make this slower than a unit test.
      timeout: 60_000,
    },
  );
  const line = out.split("\n").find((l) => l.startsWith("RESOLVED:"))!;
  return { path: line.slice("RESOLVED:".length).trim(), warned: false };
}

describe("which database file the service opens", () => {
  it("uses the new name on a fresh installation", () => {
    const resolved = resolveIn(workdir);
    expect(path.basename(resolved.path)).toBe("ironcrew.sqlite");
  });

  it("adopts the pre-rename file when that is the only one there", () => {
    // The whole point: this is somebody's existing company.
    fs.writeFileSync(path.join(workdir, "octooffice.sqlite"), "not really sqlite");
    const resolved = resolveIn(workdir);
    expect(path.basename(resolved.path)).toBe("octooffice.sqlite");
  });

  it("prefers the new name once both exist, so a completed rename sticks", () => {
    // After the operator has run the `mv`, a stale leftover must not pull the
    // service back onto the old file.
    fs.writeFileSync(path.join(workdir, "octooffice.sqlite"), "old");
    fs.writeFileSync(path.join(workdir, "ironcrew.sqlite"), "new");
    const resolved = resolveIn(workdir);
    expect(path.basename(resolved.path)).toBe("ironcrew.sqlite");
  });

  it("does not move the old file behind the operator's back", () => {
    // A backup script or a second process may still name the old path, and a
    // surprise rename under a running service is how a restore becomes an
    // outage. Adopting is read-only.
    const legacy = path.join(workdir, "octooffice.sqlite");
    fs.writeFileSync(legacy, "old");
    resolveIn(workdir);
    expect(fs.existsSync(legacy)).toBe(true);
    expect(fs.existsSync(path.join(workdir, "ironcrew.sqlite"))).toBe(false);
  });
});
