import { mkdir, open, readFile, rename, lstat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { IntegrationError } from "../integrations/src/transport.ts";
import { digest, ToolError } from "./workspace.ts";
export type ToolResult = { status: "succeeded" | "failed" | "effect_unknown"; data: unknown; resultSha256: string };
const resultSchema = z.object({
  status: z.enum(["succeeded", "failed", "effect_unknown"]),
  data: z.json(),
  resultSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const receiptSchema = z.object({
  actionId: z.uuid(),
  argsHash: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.literal("started").optional(),
  result: resultSchema.optional(),
});
/** Receipts survive process restart. An intent without a verified result never invokes the effect again. */
export class ExecutionJournal {
  directory: string;
  private active = new Map<string, { hash: string; promise: Promise<ToolResult> }>();
  constructor(directory: string) {
    this.directory = path.resolve(directory);
  }
  async execute(actionId: string, argsHash: string, operation: () => Promise<unknown>): Promise<ToolResult> {
    z.uuid().parse(actionId);
    z.string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(argsHash);
    const existing = this.active.get(actionId);
    if (existing) {
      if (existing.hash !== argsHash) throw new ToolError("action_hash_conflict");
      return existing.promise;
    }
    const promise = this.run(actionId, argsHash, operation);
    this.active.set(actionId, { hash: argsHash, promise });
    try {
      return await promise;
    } finally {
      this.active.delete(actionId);
    }
  }
  private async load(file: string, actionId: string, argsHash: string) {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 8_000_000)
      throw new ToolError("journal_corrupt");
    let prior: z.infer<typeof receiptSchema>;
    try {
      prior = receiptSchema.parse(JSON.parse(await readFile(file, "utf8")));
    } catch {
      throw new ToolError("journal_corrupt");
    }
    if (prior.actionId !== actionId || prior.argsHash !== argsHash) throw new ToolError("action_hash_conflict");
    if (prior.result && prior.result.resultSha256 !== digest(JSON.stringify(prior.result.data)))
      throw new ToolError("journal_corrupt");
    return prior;
  }
  async recover(actionId: string, argsHash: string): Promise<ToolResult | undefined> {
    z.uuid().parse(actionId);
    z.string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(argsHash);
    try {
      if ((await lstat(this.directory)).isSymbolicLink()) throw new ToolError("unsafe_journal");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const file = path.join(this.directory, actionId + ".json");
    try {
      const prior = await this.load(file, actionId, argsHash);
      if (prior.result) return prior.result;
      try {
        const complete = await this.load(file + ".result", actionId, argsHash);
        if (complete.result) {
          await rename(file + ".result", file);
          return complete.result;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const data = { code: "interrupted_after_intent" };
      return { status: "effect_unknown", data, resultSha256: digest(JSON.stringify(data)) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return undefined;
    }
  }
  private async run(actionId: string, argsHash: string, operation: () => Promise<unknown>): Promise<ToolResult> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if ((await lstat(this.directory)).isSymbolicLink()) throw new ToolError("unsafe_journal");
    const file = path.join(this.directory, actionId + ".json");
    const recovered = await this.recover(actionId, argsHash);
    if (recovered) return recovered;
    let intent;
    try {
      intent = await open(file, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        const data = { code: "concurrent_action_intent" };
        return { status: "effect_unknown", data, resultSha256: digest(JSON.stringify(data)) };
      }
      throw error;
    }
    try {
      await intent.writeFile(JSON.stringify({ actionId, argsHash, state: "started" }));
      await intent.sync();
    } finally {
      await intent.close();
    }
    let result: ToolResult;
    try {
      const data = z.json().parse(await operation());
      result = { status: "succeeded", data, resultSha256: digest(JSON.stringify(data)) };
    } catch (error) {
      const code = error instanceof ToolError || error instanceof IntegrationError ? error.code : "tool_failed",
        data = { code };
      result = {
        status:
          error instanceof IntegrationError
            ? error.effectStatus === "effect_unknown"
              ? "effect_unknown"
              : "failed"
            : [
                  "file_conflict",
                  "path_denied",
                  "fixture_not_trusted",
                  "isolation_profile_unverified",
                  "tool_not_registered",
                  "payment_data_stale",
                  "payment_data_changed",
                  "reminder_suppressed",
                ].includes(code)
              ? "failed"
              : "effect_unknown",
        data,
        resultSha256: digest(JSON.stringify(data)),
      };
    }
    const pending = await open(file + ".result", "wx", 0o600);
    try {
      await pending.writeFile(JSON.stringify({ actionId, argsHash, result }));
      await pending.sync();
    } finally {
      await pending.close();
    }
    await rename(file + ".result", file);
    return result;
  }
}
