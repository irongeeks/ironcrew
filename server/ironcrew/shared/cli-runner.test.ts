import { describe, it, expect } from "vitest";
import { spawnCliRunner, CliTimeoutError } from "./cli-runner.ts";

describe("spawnCliRunner", () => {
  it("captures stdout, stderr and exit code separately", async () => {
    const res = await spawnCliRunner([
      process.execPath,
      "-e",
      "process.stdout.write('out'); process.stderr.write('err'); process.exit(3);",
    ]);
    expect(res.stdout).toBe("out");
    expect(res.stderr).toBe("err");
    expect(res.code).toBe(3);
  });

  it("passes argv as a real array — arguments containing shell metacharacters are not interpreted", async () => {
    const res = await spawnCliRunner([process.execPath, "-e", "process.stdout.write(process.argv[1])", "a; rm -rf /"]);
    expect(res.stdout).toBe("a; rm -rf /");
  });

  it("writes input to stdin", async () => {
    const res = await spawnCliRunner(
      [
        process.execPath,
        "-e",
        "let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>process.stdout.write(d.toUpperCase()));",
      ],
      { input: "hello" },
    );
    expect(res.stdout).toBe("HELLO");
  });

  it("rejects with CliTimeoutError and kills the process when it exceeds the timeout", async () => {
    await expect(
      spawnCliRunner([process.execPath, "-e", "setInterval(() => {}, 1000);"], { timeoutMs: 100 }),
    ).rejects.toBeInstanceOf(CliTimeoutError);
  });

  it("rejects when the binary does not exist", async () => {
    await expect(spawnCliRunner(["/no/such/binary-xyz"])).rejects.toThrow();
  });

  it("rejects on empty argv", async () => {
    await expect(spawnCliRunner([])).rejects.toThrow(/empty argv/);
  });
});
