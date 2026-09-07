import { expect, it } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createFixtureLauncher } from "../fixtures/launcher.ts";
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
