import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CliAdapter, InvocationContext, AdapterStreamEvent } from "./adapter-interface.ts";

const execFileAsync = promisify(execFile);

export const claudeAdapter: CliAdapter = {
  name: "Claude Code",
  providerType: "claude",
  transport: "cli",
  supportsTokenTracking: true,
  promptDelivery: "stdin",

  buildArgs(context: InvocationContext): string[] {
    const args = [
      "claude",
      "--dangerously-skip-permissions",
      "--print",
      "--verbose",
      "--output-format=stream-json",
      "--include-partial-messages",
      "--max-turns",
      "200",
    ];
    if (context.model) args.push("--model", context.model);
    return args;
  },

  detectSubtask(raw: string): { title: string; description: string } | null {
    try {
      const j = JSON.parse(raw.trim()) as Record<string, unknown>;
      if (j.type === "tool_use" && j.tool === "Task") {
        const input = j.input as Record<string, unknown> | undefined;
        const description = (input?.description as string) || (input?.prompt as string) || "Sub-task";
        const title = description.split("\n")[0].slice(0, 100);
        return { title, description };
      }
    } catch {
      // not JSON
    }
    return null;
  },

  detectSubtaskDone(raw: string): { id: string } | null {
    try {
      const j = JSON.parse(raw.trim()) as Record<string, unknown>;
      if (j.type === "tool_result" && j.tool === "Task") {
        const id = j.id as string | undefined;
        if (id) return { id };
      }
    } catch {
      // not JSON
    }
    return null;
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

      if (j.type === "tool_use" && j.tool === "Task") {
        const input = j.input as Record<string, unknown> | undefined;
        const description = (input?.description as string) || (input?.prompt as string) || "Sub-task";
        const title = description.split("\n")[0].slice(0, 100);
        events.push({
          type: "subtask_created",
          content: title,
          metadata: { id: j.id as string, description },
        });
      } else if (j.type === "tool_result" && j.tool === "Task") {
        events.push({
          type: "subtask_done",
          content: "",
          metadata: { id: j.id as string },
        });
      } else if (j.type === "assistant" || j.type === "text") {
        const content = (j.content as string) || "";
        if (content) events.push({ type: "output", content });
      } else if (j.type === "result" && j.usage) {
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
      }
    }
    return events;
  },

  async testEnvironment(): Promise<{ ok: boolean; version?: string; message: string }> {
    try {
      const { stdout } = await execFileAsync("claude", ["--version"], { timeout: 5000 });
      return { ok: true, version: stdout.trim(), message: "claude CLI found" };
    } catch {
      return { ok: false, message: "claude CLI not found in PATH" };
    }
  },
};
