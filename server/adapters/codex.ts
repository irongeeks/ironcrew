import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CliAdapter, InvocationContext, AdapterStreamEvent } from "./adapter-interface.ts";

const execFileAsync = promisify(execFile);

export const codexAdapter: CliAdapter = {
  name: "Codex CLI",
  providerType: "codex",
  transport: "cli",
  supportsTokenTracking: false,
  promptDelivery: "stdin",

  buildArgs(context: InvocationContext): string[] {
    const args = ["codex", "--enable", "multi_agent"];
    if (context.model) args.push("-m", context.model);
    if (context.reasoningLevel) args.push("-c", `model_reasoning_effort="${context.reasoningLevel}"`);
    args.push("--yolo", "exec", "--json");
    return args;
  },

  detectSubtask(raw: string): { title: string; description: string } | null {
    try {
      const j = JSON.parse(raw.trim()) as Record<string, unknown>;
      if (j.type === "item.started") {
        const item = j.item as Record<string, unknown> | undefined;
        if (item?.type === "collab_tool_call" && item?.tool === "spawn_agent") {
          const prompt = (item.prompt as string) || "Sub-agent";
          const title = prompt
            .split("\n")[0]
            .replace(/^Task:\s*/, "")
            .slice(0, 100);
          return { title, description: prompt };
        }
      }
    } catch {
      // not JSON
    }
    return null;
  },

  detectSubtaskDone(raw: string): { id: string } | null {
    try {
      const j = JSON.parse(raw.trim()) as Record<string, unknown>;
      if (j.type === "item.completed") {
        const item = j.item as Record<string, unknown> | undefined;
        if (item?.type === "collab_tool_call" && item?.tool === "close_agent") {
          const threadIds = (item.receiver_thread_ids as string[]) || [];
          if (threadIds[0]) return { id: threadIds[0] };
        }
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

      if (j.type === "item.started") {
        const item = j.item as Record<string, unknown> | undefined;
        if (item?.type === "collab_tool_call" && item?.tool === "spawn_agent") {
          const itemId = (item.id as string) || `codex-spawn-${Date.now()}`;
          const prompt = (item.prompt as string) || "Sub-agent";
          const title = prompt
            .split("\n")[0]
            .replace(/^Task:\s*/, "")
            .slice(0, 100);
          events.push({
            type: "subtask_created",
            content: title,
            metadata: { id: itemId, description: prompt },
          });
        }
      } else if (j.type === "item.completed") {
        const item = j.item as Record<string, unknown> | undefined;
        if (item?.type === "collab_tool_call" && item?.tool === "close_agent") {
          const threadIds = (item.receiver_thread_ids as string[]) || [];
          for (const tid of threadIds) {
            events.push({ type: "subtask_done", content: "", metadata: { threadId: tid } });
          }
        }
      } else if (j.type === "output" || j.type === "message") {
        const content = (j.content as string) || "";
        if (content) events.push({ type: "output", content });
      }
    }
    return events;
  },

  async testEnvironment(): Promise<{ ok: boolean; version?: string; message: string }> {
    try {
      const { stdout } = await execFileAsync("codex", ["--version"], { timeout: 5000 });
      return { ok: true, version: stdout.trim(), message: "codex CLI found" };
    } catch {
      return { ok: false, message: "codex CLI not found in PATH" };
    }
  },
};
