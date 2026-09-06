import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("E2E launcher refuses existing servers", () => {
  it.each([8791, 8810])("aborts before preparing data when port %i is occupied", async (port) => {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    const runId = randomBytes(16).toString("hex");
    try {
      const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/start-e2e.ts"], {
        cwd: root,
        env: { ...process.env, IRONCREW_E2E_RUN_ID: runId },
        encoding: "utf8",
        timeout: 15_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`E2E port ${port} is occupied`);
      expect(fs.existsSync(path.join(root, ".tmp", "e2e-runtime", runId))).toBe(false);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
