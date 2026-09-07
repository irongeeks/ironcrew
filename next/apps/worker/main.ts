import { loadExecutionPort } from "../../packages/tools/isolation/index.ts";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { WorkerClient } from "./client.ts";
import { Workspace, ToolError } from "../../packages/tools/workspace.ts";
import type { Json } from "../../packages/contracts/src/index.ts";
const configSchema = z
  .object({
    url: z.url(),
    workerId: z.uuid(),
    token: z.string().min(32),
    generation: z.number().int().positive(),
    capabilities: z.array(
      z.enum(["workspace.read", "workspace.apply_patch", "workspace.test_fixture", "workspace.execute"]),
    ),
    directory: z.string().min(1),
    caFile: z.string().optional(),
    isolationProfilePath: z.string().min(1).optional(),
    trustedFixtures: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)).default({}),
  })
  .strict();
const file = process.argv[2];
if (!file) throw new Error("Usage: node apps/worker/main.ts /absolute/path/worker.json");
const config = configSchema.parse(JSON.parse(await readFile(path.resolve(file), "utf8")));
const directory = path.resolve(config.directory);
await mkdir(directory, { recursive: true, mode: 0o700 });
const executionPort = config.isolationProfilePath ? await loadExecutionPort(config.isolationProfilePath) : undefined;
if (config.capabilities.includes("workspace.execute") && !executionPort)
  throw new Error("workspace.execute requires an attested Linux isolation profile");
const client = new WorkerClient({
  ...config,
  executionPort,
  attestation: executionPort?.attestation,
  directory,
  ca: config.caFile ? await readFile(path.resolve(config.caFile)) : undefined,
  execute: async (action, signal) => {
    signal.throwIfAborted();
    const workspace = new Workspace(path.join(directory, "workspaces", action.orderId), { executionPort });
    await workspace.init();
    if (action.toolId === "workspace.read")
      return workspace.read(z.object({ path: z.string() }).parse(action.args).path);
    if (action.toolId === "workspace.apply_patch") return workspace.applyPatch(action.args);
    if (action.toolId === "workspace.test_fixture") {
      const relative = z.object({ path: z.string() }).parse(action.args).path,
        hash = config.trustedFixtures[relative];
      if (!hash) throw new ToolError("fixture_not_trusted");
      return (await workspace.testFixture(relative, hash)) as unknown as Json;
    }
    if (action.toolId === "workspace.execute") return workspace.execute(action.args, undefined, signal);
    throw new ToolError("tool_not_registered");
  },
});
await client.start();
process.once("SIGTERM", () => void client.stop());
process.once("SIGINT", () => void client.stop());
