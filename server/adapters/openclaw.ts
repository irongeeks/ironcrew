import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CliAdapter, InvocationContext, AdapterStreamEvent } from "./adapter-interface.ts";

const execFileAsync = promisify(execFile);

export const openclawAdapter: CliAdapter = {
  name: "OpenClaw",
  providerType: "openclaw",
  transport: "cli",
  supportsTokenTracking: true,
  promptDelivery: "flag",
  promptFlag: "--message",
  sessionFlag: "--session-id",

  buildArgs(context: InvocationContext): string[] {
    const args = ["openclaw"];
    if (context.profile) args.push("--profile", context.profile);
    args.push("agent", "--local", "--json");
    // model is set in the profile config, not via CLI flag
    // prompt is delivered via --message flag (appended by spawnCliAgent)
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

      if (j.type === "result" && j.usage) {
        const usage = j.usage as Record<string, unknown>;
        events.push({
          type: "token_usage",
          content: "",
          metadata: {
            input_tokens: (usage.input_tokens as number) ?? 0,
            output_tokens: (usage.output_tokens as number) ?? 0,
            cache_read_tokens: (usage.cache_read_input_tokens as number) ?? 0,
            cache_write_tokens: (usage.cache_creation_input_tokens as number) ?? 0,
            model: j.model as string | undefined,
          },
        });
        continue;
      }

      const content = (j.content as string) || (j.text as string) || (j.message as string) || "";
      if (content) events.push({ type: "output", content });
    }
    return events;
  },

  async testEnvironment(): Promise<{ ok: boolean; version?: string; message: string }> {
    try {
      const { stdout } = await execFileAsync("openclaw", ["--version"], { timeout: 5000 });
      return { ok: true, version: stdout.trim(), message: "openclaw CLI found" };
    } catch {
      return { ok: false, message: "openclaw CLI not found in PATH" };
    }
  },
};
