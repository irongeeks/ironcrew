import { expect, it } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createFixtureLauncher } from "../fixtures/launcher.ts";
function killOwnedProcess(pid: number) {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

it("launches a real script with exact difficult argv, inherited standard streams and exit status", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "fixture launcher space-"));
  try {
    const executable = await createFixtureLauncher(
      directory,
      "child",
      `let input='';for await(const chunk of process.stdin)input+=chunk;process.stdout.write(JSON.stringify({args:process.argv.slice(2),input}));process.stderr.write('fixture diagnostic');process.exitCode=23;`,
    );
    if (process.platform === "win32") expect((await readFile(executable)).subarray(0, 2).toString()).toBe("MZ");
    const args = [
      "plain",
      "space value",
      "",
      'quoted"value',
      "back\\slash",
      "trailing\\",
      'before\\"quote',
      "Grüße",
      "& | > %PATH%",
    ];
    const child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"], shell: false });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (b) => (stdout += b));
    child.stderr.on("data", (b) => (stderr += b));
    const result = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    child.stdin.end("actual stdin bytes");
    expect(await result).toBe(23);
    expect(JSON.parse(stdout)).toEqual({ args, input: "actual stdin bytes" });
    expect(stderr).toBe("fixture diagnostic");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 45000);

it("returns broker stdout before an owned detached service exits", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "fixture detached launcher-"));
  const pidFile = path.join(directory, "service.pid");
  let servicePid: number | undefined;
  try {
    const executable = await createFixtureLauncher(
      directory,
      "starter",
      `
      import {spawn} from 'node:child_process'; import {writeFile} from 'node:fs/promises';
      const service = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {detached:true,stdio:'ignore'});
      await new Promise((resolve,reject)=>{service.once('spawn',resolve);service.once('error',reject)});
      service.unref(); await writeFile(process.argv[2],String(service.pid));
      process.stdout.write(JSON.stringify({servicePid:service.pid,state:'running'}));
    `,
    );
    const result = await promisify(execFile)(executable, [pidFile], { timeout: 5000, maxBuffer: 4096 });
    servicePid = Number(await readFile(pidFile, "utf8"));
    expect(JSON.parse(result.stdout)).toEqual({ servicePid, state: "running" });
    expect(() => process.kill(servicePid!, 0)).not.toThrow();
  } finally {
    servicePid ??= Number(await readFile(pidFile, "utf8").catch(() => "0")) || undefined;
    if (servicePid) {
      killOwnedProcess(servicePid);
      await expect
        .poll(() => {
          try {
            process.kill(servicePid!, 0);
            return true;
          } catch {
            return false;
          }
        })
        .toBe(false);
    }
    await rm(directory, { recursive: true, force: true });
  }
}, 45000);

it("relays binary stdin stdout and stderr without text conversion or pipe deadlock", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "fixture binary launcher-"));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const executable = await createFixtureLauncher(
      directory,
      "binary",
      `
      import {once} from 'node:events';
      for await (const chunk of process.stdin) {
        if(!process.stdout.write(chunk)) await once(process.stdout,'drain');
        if(!process.stderr.write(chunk)) await once(process.stderr,'drain');
      }
    `,
    );
    const bytes = Buffer.from(Array.from({ length: 1024 * 1024 }, (_, i) => i % 256));
    child = spawn(executable, [], { stdio: ["pipe", "pipe", "pipe"] });
    const output: Buffer[] = [],
      error: Buffer[] = [];
    child.stdout!.on("data", (b) => output.push(b));
    child.stderr!.on("data", (b) => error.push(b));
    const closed = new Promise<number | null>((resolve, reject) => {
      child!.once("error", reject);
      child!.once("close", resolve);
    });
    child.stdin!.end(bytes);
    expect(await closed).toBe(0);
    expect(Buffer.concat(output).equals(bytes)).toBe(true);
    expect(Buffer.concat(error).equals(bytes)).toBe(true);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>((r) => child!.once("close", () => r()));
      child.kill("SIGKILL");
      await closed;
    }
    await rm(directory, { recursive: true, force: true });
  }
}, 45000);
