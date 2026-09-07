import { it, expect } from "vitest";
import { mkdtemp, rm, access } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { Repository } from "../../packages/persistence/src/index.ts";
it("native control process drains and releases database and instance lock through its SIGTERM handler", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ironcrew-control-lifecycle-"));
  // Windows kill(SIGTERM) terminates abruptly. This test-only preload invokes the same real
  // product handler through an inherited IPC channel; it creates no product control endpoint.
  const preload =
    process.platform === "win32"
      ? [
          "--import",
          "data:text/javascript," +
            encodeURIComponent(
              "process.on('message',m=>{if(m==='fixture-shutdown')process.emit('SIGTERM')});process.channel?.unref();",
            ),
        ]
      : [];
  const child = spawn(process.execPath, ["--experimental-strip-types", ...preload, "apps/control/main.ts"], {
    cwd: process.cwd(),
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
  let closed = false;
  let stderr = "";
  const exit = new Promise<number | null>((resolve) =>
    child.once("close", (code) => {
      closed = true;
      resolve(code);
    }),
  );
  child.on("error", () => {});
  child.stderr!.on("data", (bytes) => {
    stderr += bytes.toString();
  });
  async function waitForExit(timeoutMs: number) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        exit,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Control did not close within ${timeoutMs}ms: ${stderr}`)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  try {
    await new Promise<void>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error(`Control startup timeout: ${stderr}`)), 30000);
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Control exited before ready: ${code}`));
      });
      child.stdout!.on("data", (bytes) => {
        output += bytes.toString();
        if (output.includes("IronCrew:")) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    if (process.platform === "win32") child.send("fixture-shutdown");
    else child.kill("SIGTERM");
    expect(await waitForExit(10000)).toBe(0);
    await expect(access(path.join(directory, "instance.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    const repo = await Repository.open(path.join(directory, "company.sqlite"));
    try {
      expect(await repo.setupState()).toBeNull();
    } finally {
      await repo.close();
    }
  } finally {
    if (!closed) {
      child.kill("SIGKILL");
      await waitForExit(5000);
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 50000);
