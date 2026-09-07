import { it, expect, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, mkdir, rename, access, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { acquireInstanceLock } from "../../packages/operations/src/index.ts";
import { createFixtureLauncher } from "../fixtures/launcher.ts";
import { Repository } from "../../packages/persistence/src/index.ts";
const root = process.cwd();
const children = new Set<ReturnType<typeof start>>();
const directories = new Set<string>();
const STARTUP_TIMEOUT_MS = 30000;
function start(entry: string, directory: string, args: string[] = []) {
  // Windows has no POSIX SIGTERM delivery. The test-only preload invokes the real shutdown handler via IPC.
  const preload =
    process.platform === "win32" && entry === "apps/control/main.ts"
      ? [
          "--import",
          "data:text/javascript," +
            encodeURIComponent(
              "process.on('message',m=>{if(m==='fixture-shutdown')process.emit('SIGTERM')});process.channel?.unref();",
            ),
        ]
      : [];
  const child = spawn(process.execPath, ["--experimental-strip-types", ...preload, entry, ...args], {
    cwd: root,
    detached: process.platform !== "win32",
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
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stdout = "",
    stderr = "",
    closed = false;
  const exit = new Promise<number | null>((resolve) =>
    child.once("close", (code) => {
      closed = true;
      resolve(code);
    }),
  );
  // A failed spawn still closes; never leave an unhandled EventEmitter error behind.
  child.on("error", () => {});
  child.stdout!.on("data", (bytes) => {
    stdout += bytes.toString();
  });
  child.stderr!.on("data", (bytes) => {
    stderr += bytes.toString();
  });
  // CLI backup/restore emit no Control readiness marker. Do not create an unobserved readiness timer for them.
  const ready = (timeoutMs = STARTUP_TIMEOUT_MS) =>
    new Promise<"ready" | "exit">((resolve, reject) => {
      if (stdout.includes("IronCrew:")) return resolve("ready");
      if (closed || child.exitCode !== null || child.signalCode !== null) return resolve("exit");
      const finish = (state?: "ready" | "exit") => {
        clearTimeout(timer);
        child.stdout!.off("data", onData);
        child.off("close", onClose);
        if (state) resolve(state);
        else reject(new Error(`Child did not reach startup or exit within ${timeoutMs}ms`));
      };
      const onData = () => {
        if (stdout.includes("IronCrew:")) finish("ready");
      };
      const onClose = () => finish("exit");
      const timer = setTimeout(() => finish(), timeoutMs);
      child.stdout!.on("data", onData);
      child.once("close", onClose);
    });
  const result = { child, exit, ready, stdout: () => stdout, stderr: () => stderr, closed: () => closed };
  children.add(result);
  return result;
}
async function stop(p: ReturnType<typeof start>) {
  if (!p.closed()) {
    const signal = async (value: NodeJS.Signals) => {
      if (!p.child.pid) return;
      try {
        if (process.platform !== "win32") process.kill(-p.child.pid, value);
        else {
          const executable = path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
          await promisify(execFile)(executable, ["/PID", String(p.child.pid), "/T", "/F"], {
            timeout: 5000,
            windowsHide: true,
          }).catch((error) => {
            if (p.child.exitCode === null && p.child.signalCode === null) throw error;
          });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    await signal("SIGTERM");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const closed = await Promise.race([
      p.exit.then(() => true),
      new Promise<false>((r) => {
        timer = setTimeout(() => r(false), 1000);
      }),
    ]);
    clearTimeout(timer);
    if (!closed) {
      await signal("SIGKILL");
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          p.exit,
          new Promise<never>((_, reject) => {
            deadline = setTimeout(() => reject(new Error("Own fixture process did not close after kill")), 5000);
          }),
        ]);
      } finally {
        clearTimeout(deadline);
      }
    }
  }
  children.delete(p);
}
async function fixture() {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "ironcrew-instance-lock-")));
  directories.add(directory);
  return directory;
}
afterEach(async () => {
  // Every process, including contenders created midway through a test, must close before deleting its data.
  await Promise.all([...children].map(stop));
  for (const directory of directories)
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  directories.clear();
}, 15000);
it("two real control processes contend for one stale lock and exactly one starts", async () => {
  const directory = await fixture();
  await writeFile(path.join(directory, "instance.lock"), "2147483647");
  const processes = [start("apps/control/main.ts", directory), start("apps/control/main.ts", directory)];
  try {
    const states = await Promise.all(processes.map((p) => p.ready()));
    expect(states.sort()).toEqual(["exit", "ready"]);
    const winner = processes.find((p) => p.child.exitCode === null)!,
      loser = processes.find((p) => p !== winner)!;
    expect(await loser.exit).toBe(1);
    expect(loser.stderr()).toContain("instance_running");
    const owned = JSON.parse(await readFile(path.join(directory, "instance.lock"), "utf8"));
    expect(owned.pid).toBe(winner.child.pid);
    expect(owned.token).toMatch(/^[a-f0-9-]{36}$/);
    if (process.platform === "win32") winner.child.send("fixture-shutdown");
    else winner.child.kill("SIGTERM");
    expect(await winner.exit).toBe(0);
    await expect(access(path.join(directory, "instance.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await Promise.all(processes.map(stop));
  }
}, 45000);
it("will not release a replaced lock or silently recover an abandoned takeover marker", async () => {
  const directory = await fixture();
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
    expect(await competitor.ready()).toBe("exit");
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
    await Promise.all([...children].map(stop));
  }
}, 45000);
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
    const reached = path.join(parent, "age-started"),
      proceed = path.join(parent, "continue");
    const gatedAge = await createFixtureLauncher(
      parent,
      "gated-age",
      `import fs from 'node:fs';import {spawn} from 'node:child_process';fs.writeFileSync(${JSON.stringify(reached)},'ready');while(!fs.existsSync(${JSON.stringify(proceed)}))await new Promise(r=>setTimeout(r,10));const child=spawn(${JSON.stringify(age)},process.argv.slice(2),{stdio:'inherit'});child.once('exit',code=>process.exit(code??1));\n`,
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
      const acquireDeadline = Date.now() + STARTUP_TIMEOUT_MS;
      while (!existsSync(reached)) {
        if (Date.now() >= acquireDeadline || cli.closed()) throw new Error("CLI did not acquire its lock");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const contender = start("apps/control/main.ts", directory);
      expect(await contender.ready()).toBe("exit");
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
      await writeFile(proceed, "continue");
      await Promise.all([...children].map(stop));
    }
  },
  60000,
);

it("cleans an actually running child after a startup deadline before removing its workspace", async () => {
  const directory = await fixture();
  const child = start("--eval", directory, ["setInterval(()=>{},1000)"]);
  await expect(child.ready(25)).rejects.toThrow("within 25ms");
  await stop(child);
  expect(child.closed()).toBe(true);
  expect(children.has(child)).toBe(false);
  await rm(directory, { recursive: true });
  await expect(access(directory)).rejects.toMatchObject({ code: "ENOENT" });
});
