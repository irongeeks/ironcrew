import { it, expect } from "vitest";
import { mkdtemp, rm, writeFile, readFile, mkdir, rename, access, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { acquireInstanceLock } from "../../packages/operations/src/index.ts";
import { Repository } from "../../packages/persistence/src/index.ts";
const root = process.cwd();
function start(entry: string, directory: string, args: string[] = []) {
  const child = spawn(process.execPath, ["--experimental-strip-types", entry, ...args], {
    cwd: root,
    env: {
      ...process.env,
      IRONCREW_DATA_DIR: directory,
      IRONCREW_HOST: "127.0.0.1",
      IRONCREW_PORT: "0",
      IRONCREW_PREVIEW_PORT: "0",
      IRONCREW_PUBLIC_URL: "http://127.0.0.1:0",
      IRONCREW_TLS_CERT: "",
      IRONCREW_TLS_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  const exit = new Promise<number | null>((resolve) => child.once("exit", resolve));
  child.stdout.on("data", (bytes) => {
    stdout += bytes.toString();
  });
  child.stderr.on("data", (bytes) => {
    stderr += bytes.toString();
  });
  const ready = new Promise<"ready" | "exit">((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Child did not reach startup or exit")), 5000);
    child.stdout.on("data", () => {
      if (stdout.includes("IronCrew:")) {
        clearTimeout(timer);
        resolve("ready");
      }
    });
    child.once("exit", () => {
      clearTimeout(timer);
      resolve("exit");
    });
  });
  return { child, exit, ready, stdout: () => stdout, stderr: () => stderr };
}
async function fixture() {
  return realpath(await mkdtemp(path.join(tmpdir(), "ironcrew-instance-lock-")));
}
it("two real control processes contend for one stale lock and exactly one starts", async () => {
  const directory = await fixture();
  await writeFile(path.join(directory, "instance.lock"), "2147483647");
  const processes = [start("apps/control/main.ts", directory), start("apps/control/main.ts", directory)];
  try {
    const states = await Promise.all(processes.map((p) => p.ready));
    expect(states.sort()).toEqual(["exit", "ready"]);
    const winner = processes.find((p) => p.child.exitCode === null)!,
      loser = processes.find((p) => p !== winner)!;
    expect(await loser.exit).toBe(1);
    expect(loser.stderr()).toContain("instance_running");
    const owned = JSON.parse(await readFile(path.join(directory, "instance.lock"), "utf8"));
    expect(owned.pid).toBe(winner.child.pid);
    expect(owned.token).toMatch(/^[a-f0-9-]{36}$/);
    winner.child.kill("SIGTERM");
    expect(await winner.exit).toBe(0);
    await expect(access(path.join(directory, "instance.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    for (const p of processes)
      if (p.child.exitCode === null) {
        p.child.kill("SIGKILL");
        await p.exit;
      }
    await rm(directory, { recursive: true, force: true });
  }
}, 10000);
it("will not release a replaced lock or silently recover an abandoned takeover marker", async () => {
  const directory = await fixture();
  try {
    const lease = await acquireInstanceLock(directory, "fixture");
    const replacement = path.join(directory, "replacement");
    await writeFile(replacement, JSON.stringify({ version: 1, pid: process.pid, token: randomUUID() }));
    await rename(replacement, path.join(directory, "instance.lock"));
    await expect(lease.release()).rejects.toMatchObject({ code: "lock_ownership_changed" });
    expect(JSON.parse(await readFile(path.join(directory, "instance.lock"), "utf8")).token).toBeDefined();
    await writeFile(
      path.join(directory, ".instance-acquire.lock"),
      JSON.stringify({ version: 1, pid: 2147483647, token: randomUUID() }),
    );
    await expect(acquireInstanceLock(directory)).rejects.toMatchObject({ code: "lock_recovery_required" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
it("fences the rename gap during restore and transfers owned lock across activation", async () => {
  const parent = await fixture(),
    directory = path.join(parent, "data"),
    staged = path.join(parent, "stage"),
    previous = directory + ".before-recovery-" + randomUUID();
  await mkdir(staged);
  const lease = await acquireInstanceLock(directory, "restore");
  try {
    const replacement = await lease.prepareReplacement(staged);
    await rename(directory, previous);
    const competitor = start("apps/control/main.ts", directory);
    expect(await competitor.ready).toBe("exit");
    expect(await competitor.exit).toBe(1);
    await expect(access(directory)).rejects.toMatchObject({ code: "ENOENT" });
    await rename(staged, directory);
    await replacement.finish(previous);
    await expect(acquireInstanceLock(directory)).rejects.toMatchObject({ code: "instance_running" });
    await lease.release();
    const next = await acquireInstanceLock(directory);
    await next.release();
    await expect(access(path.join(previous, "instance.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}, 10000);
const age = process.env.IRONCREW_TEST_AGE ?? "/tmp/ironcrew-age-1.3.2/age/age";
const keygen = process.env.IRONCREW_TEST_AGE_KEYGEN ?? path.join(path.dirname(age), "age-keygen");
it.skipIf(!existsSync(age) || !existsSync(keygen))(
  "an actual offline CLI backup holds the shared instance lock and CLI restore transfers it safely",
  async () => {
    const parent = await fixture(),
      directory = path.join(parent, "data");
    await mkdir(directory);
    const repo = await Repository.open(path.join(directory, "company.sqlite"));
    await repo.setup({
      companyName: "CLI fixture",
      ceoName: "CEO",
      passwordHash: "fixture",
      timezone: "UTC",
      budgetLimitUsdMicros: "0",
    });
    await repo.close();
    const identity = path.join(parent, "identity.txt");
    await promisify(execFile)(keygen, ["--output", identity]);
    const recipient = (await readFile(identity, "utf8")).match(/# public key: (age1\S+)/)![1];
    // A pinned-version compatible executable fixture waits at startup, then delegates encryption to real age.
    const gatedAge = path.join(parent, "gated-age"),
      reached = path.join(parent, "age-started"),
      proceed = path.join(parent, "continue");
    await writeFile(
      gatedAge,
      `#!${process.execPath}\nimport fs from 'node:fs';import {spawn} from 'node:child_process';fs.writeFileSync(${JSON.stringify(reached)},'ready');while(!fs.existsSync(${JSON.stringify(proceed)}))await new Promise(r=>setTimeout(r,10));const child=spawn(${JSON.stringify(age)},process.argv.slice(2),{stdio:'inherit'});child.once('exit',code=>process.exit(code??1));\n`,
      { mode: 0o700 },
    );
    const cli = start("apps/cli/main.ts", directory, [
      "backup",
      "--data-dir",
      directory,
      "--age",
      gatedAge,
      "--recipient",
      recipient,
      "--output",
      path.join(parent, "backups"),
    ]);
    try {
      for (let attempt = 0; !existsSync(reached); attempt++) {
        if (attempt > 300) throw new Error("CLI did not acquire its lock");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const contender = start("apps/control/main.ts", directory);
      expect(await contender.ready).toBe("exit");
      expect(await contender.exit).toBe(1);
      expect(contender.stderr()).toContain("instance_running");
      expect(JSON.parse(await readFile(path.join(directory, "instance.lock"), "utf8")).purpose).toBe("offline-backup");
      await writeFile(proceed, "continue");
      expect(await cli.exit).toBe(0);
      const backup = JSON.parse(cli.stdout());
      const restore = start("apps/cli/main.ts", directory, [
        "restore",
        "--data-dir",
        directory,
        "--age",
        age,
        "--identity",
        identity,
        "--archive",
        backup.archivePath,
      ]);
      expect(await restore.exit).toBe(0);
      const result = JSON.parse(restore.stdout());
      expect(result.recovery.dispatchPaused).toBe(true);
      await expect(access(path.join(directory, "instance.lock"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(path.join(result.previousDirectory, "instance.lock"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      if (cli.child.exitCode === null) {
        cli.child.kill("SIGKILL");
        await cli.exit;
      }
      await rm(parent, { recursive: true, force: true });
    }
  },
  15000,
);
