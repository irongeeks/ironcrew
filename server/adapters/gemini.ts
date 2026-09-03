import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CliAdapter, InvocationContext, AdapterStreamEvent } from "./adapter-interface.ts";

const execFileAsync = promisify(execFile);

export const geminiAdapter: CliAdapter = {
  name: "Gemini CLI",
  providerType: "gemini",
  transport: "cli",
  supportsTokenTracking: false,
  promptDelivery: "stdin",

  buildArgs(context: InvocationContext): string[] {
    const args = ["gemini"];
    if (context.model) args.push("-m", context.model);
    args.push("--yolo", "--output-format=stream-json");
    return args;
  },

  detectSubtask(raw: string): { title: string; description: string } | null {
    try {
      const j = JSON.parse(raw.trim()) as Record<string, unknown>;
      if (j.type === "message" && j.content) {
        const content = j.content as string;
        const planMatch = content.match(/\{"subtasks"\s*:\s*\[.*?\]\}/s);
        if (planMatch) {
          const plan = JSON.parse(planMatch[0]) as { subtasks: { title: string }[] };
          if (plan.subtasks.length > 0) {
            const first = plan.subtasks[0];
            return { title: first.title, description: content };
          }
        }
      }
    } catch {
      // not JSON or no subtasks
    }
    return null;
  },

  detectSubtaskDone(raw: string): { id: string } | null {
    try {
      const j = JSON.parse(raw.trim()) as Record<string, unknown>;
      if (j.type === "message" && j.content) {
        const content = j.content as string;
        const doneMatch = content.match(/\{"subtask_done"\s*:\s*"(.+?)"\}/);
        if (doneMatch) {
          return { id: doneMatch[1] };
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

      if (j.type === "message" && j.content) {
        const content = j.content as string;

        // Detect plan output: {"subtasks": [...]}
        const planMatch = content.match(/\{"subtasks"\s*:\s*\[.*?\]\}/s);
        if (planMatch) {
          try {
            const plan = JSON.parse(planMatch[0]) as { subtasks: { title: string }[] };
            for (const st of plan.subtasks) {
              const stId = `gemini-plan-${st.title.slice(0, 30).replace(/\s/g, "-")}-${Date.now()}`;
              events.push({
                type: "subtask_created",
                content: st.title,
                metadata: { id: stId },
              });
            }
          } catch {
            // malformed JSON — emit as plain output
            events.push({ type: "output", content });
          }
        } else {
          // Detect completion report: {"subtask_done": "..."}
          const doneMatch = content.match(/\{"subtask_done"\s*:\s*"(.+?)"\}/);
          if (doneMatch) {
            events.push({ type: "subtask_done", content: "", metadata: { title: doneMatch[1] } });
          } else {
            events.push({ type: "output", content });
          }
        }
      }
    }
    return events;
  },

  async testEnvironment(): Promise<{ ok: boolean; version?: string; message: string }> {
    try {
      const { stdout } = await execFileAsync("gemini", ["--version"], { timeout: 5000 });
      return { ok: true, version: stdout.trim(), message: "gemini CLI found" };
    } catch {
      return { ok: false, message: "gemini CLI not found in PATH" };
    }
  },
};
