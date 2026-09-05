import { it, expect } from "vitest";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// Exercise the real plain-node launcher, including its tsx child. A synchronous
// spawn cannot be interrupted by Vitest's timeout, and killing only that parent
// can leave descendants holding its stdio open. Bound the whole process group.
function runCli(args, directory, deadlineMs = 15000) {
  return new Promise((resolve, reject) => {
    const env = Object.fromEntries(
      ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SystemRoot"]
        .filter((name) => process.env[name] !== undefined)
        .map((name) => [name, process.env[name]]),
    );
    const child = spawn(process.execPath, args, {
      cwd: directory,
      env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "",
      failure;
    const stop = () => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") failure ??= error;
      }
    };
    const timer = setTimeout(() => {
      failure = new Error("Backup CLI exceeded its 15-second test deadline.");
      stop();
    }, deadlineMs);
    const collect = (stream, chunk) => {
      if (stream === "stdout") stdout += chunk;
      else stderr += chunk;
      if (stdout.length + stderr.length > 1024 * 1024) {
        failure = new Error("Backup CLI exceeded test output limit.");
        stop();
      }
    };
    child.stdout.setEncoding("utf8").on("data", (chunk) => collect("stdout", chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => collect("stderr", chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (status) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else resolve({ status, stdout, stderr });
    });
  });
}
it("backup and restore CLI preserve relative paths from a rescue working directory", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "crew-backup-cli-"));
  try {
    const db = new DatabaseSync(path.join(directory, "source.sqlite"));
    db.exec("CREATE TABLE evidence(value TEXT); INSERT INTO evidence VALUES('durable source')");
    db.close();
    const backup = await runCli(
      [path.join(root, "scripts/ironcrew-backup.mjs"), "--db", "source.sqlite", "--out", "backups"],
      directory,
    );
    expect(backup.status, backup.stderr).toBe(0);
    const archive = readdirSync(path.join(directory, "backups")).find((name) => name.endsWith(".tar.gz"));
    expect(archive).toBeTruthy();
    const restore = await runCli(
      [
        path.join(root, "scripts/ironcrew-backup.mjs"),
        "--restore",
        path.join("backups", archive),
        "--db",
        "restored.sqlite",
      ],
      directory,
    );
    expect(restore.status, restore.stderr).toBe(0);
    expect(existsSync(path.join(directory, "restored.sqlite"))).toBe(true);
    const restored = new DatabaseSync(path.join(directory, "restored.sqlite"), { readOnly: true });
    expect(restored.prepare("SELECT value FROM evidence").get().value).toBe("durable source");
    restored.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 35000);

it("terminates a stuck CLI process group instead of blocking the test worker", async () => {
  await expect(
    runCli(
      [
        "-e",
        `const {spawn}=require('node:child_process');
    spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});
    setInterval(()=>{},1000);`,
      ],
      root,
      500,
    ),
  ).rejects.toThrow("test deadline");
}, 5000);
