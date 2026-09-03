import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CliAdapter, InvocationContext, AdapterStreamEvent } from "./adapter-interface.ts";

const execFileAsync = promisify(execFile);

export const opencodeAdapter: CliAdapter = {
  name: "OpenCode",
  providerType: "opencode",
  transport: "cli",
  supportsTokenTracking: false,
  promptDelivery: "stdin",

  buildArgs(context: InvocationContext): string[] {
    const args = ["opencode", "run"];
    if (context.model) args.push("-m", context.model);
    args.push("--format", "json");
    return args;
  },

  parseStreamChunk(raw: string): AdapterStreamEvent[] {
    const events: AdapterStreamEvent[] = [];
    const lines = raw.split("\n").filter(Boolean);
    for (const line of lines) {
      let j: Record<string, unknown>;
      try {
        j = JSON.parse(line);
      } catch {
        if (line.trim()) {
          events.push({ type: "output", content: line });
        }
        continue;
      }

      const content = (j.content as string) || (j.text as string) || (j.message as string) || "";
      if (content) events.push({ type: "output", content });
    }
    return events;
  },

  async testEnvironment(): Promise<{ ok: boolean; version?: string; message: string }> {
    try {
      const { stdout } = await execFileAsync("opencode", ["--version"], { timeout: 5000 });
      return { ok: true, version: stdout.trim(), message: "opencode CLI found" };
    } catch {
      return { ok: false, message: "opencode CLI not found in PATH" };
    }
  },
};
