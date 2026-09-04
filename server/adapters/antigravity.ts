/**
 * Antigravity CLI (`agy`) — Google's terminal coding agent.
 *
 * This replaces an inherited HTTP stub that pointed at
 * `https://api.antigravity.ai/v1/chat/completions`, an endpoint that does not
 * exist: its `parseStreamChunk` returned `[]` (so all output was silently
 * lost) and its `testEnvironment` always reported failure. Antigravity ships
 * as a single Go binary named `agy` that shares an agent core with the
 * desktop app, so it belongs with the other CLI adapters, not with HTTP.
 *
 * The flags below come from the published headless-mode documentation
 * (https://antigravity.google/docs/cli/headless/), not from guessing:
 *
 *   -p / --print          one prompt, non-interactive, then exit
 *   --output-format       text | json | stream-json
 *   --model               model slug (`agy models` lists them)
 *   --effort              low | medium | high
 *   --sandbox             terminal sandbox restrictions
 *   --dangerously-skip-permissions   auto-approve every tool request
 *
 * PROMPT DELIVERY IS BY FLAG, AND THAT IS NOT A PREFERENCE
 *
 * `-p` takes the prompt as an argument and ignores stdin; stdin only carries
 * prompts under `--input-format stream-json`, which additionally requires
 * `--output-format stream-json` and a different framing. So this adapter
 * declares `promptDelivery: "flag"`, and the runtime appends it — see
 * cli-adapter-runtime.ts, which appends the prompt *after* the permission
 * guard has run, so that a prompt merely mentioning `--yolo` cannot be
 * mistaken for one.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CliAdapter, InvocationContext, AdapterStreamEvent } from "./adapter-interface.ts";
import { permissionArgsFor } from "../ironcrew/policy/runtime-permissions.ts";

const execFileAsync = promisify(execFile);

export const antigravityAdapter: CliAdapter = {
  name: "Antigravity CLI",
  providerType: "antigravity",
  transport: "cli",
  // The result event carries a `usage` object, but its field names are not
  // documented. Rather than guess at `input_tokens` and quietly report wrong
  // numbers, the raw object is attached to the final output event and this
  // stays false.
  supportsTokenTracking: false,
  promptDelivery: "flag",
  promptFlag: "-p",

  buildArgs(context: InvocationContext): string[] {
    const args = ["agy"];
    if (context.model) args.push("--model", context.model);
    if (context.reasoningLevel) args.push("--effort", context.reasoningLevel);
    args.push(...permissionArgsFor("antigravity", context.permissionMode ?? "restricted"));
    args.push("--output-format", "stream-json");
    return args;
  },

  /**
   * One NDJSON event per line: `init` once, `step_update` per step, `result`
   * at the end of a turn.
   */
  parseStreamChunk(raw: string): AdapterStreamEvent[] {
    const events: AdapterStreamEvent[] = [];

    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        // Not JSON: a warning from the binary, or output from before the
        // stream started. Losing it would make a failure unreadable.
        events.push({ type: "output", content: trimmed });
        continue;
      }

      if (parsed.event === "step_update") {
        const step = (parsed.step_update ?? {}) as Record<string, unknown>;
        // Only completed steps: a step reported at every state change would
        // put the same line in the run log three times.
        if (step.state !== "DONE") continue;
        const stepType = typeof step.step_type === "string" ? step.step_type : "step";
        if (stepType === "user_input") continue;
        events.push({
          type: "tool_use",
          content: stepType,
          metadata: { stepIndex: step.step_index, conversationId: step.conversation_id },
        });
        continue;
      }

      if (parsed.event === "result") {
        const result = (parsed.result ?? {}) as Record<string, unknown>;
        const response = typeof result.response === "string" ? result.response : "";
        const failed = typeof result.status === "string" && result.status !== "SUCCESS";
        if (failed) {
          events.push({
            type: "error",
            content: response || `agy beendete den Lauf mit Status "${String(result.status)}".`,
            metadata: { status: result.status, conversationId: result.conversation_id },
          });
          continue;
        }
        if (response) {
          events.push({
            type: "output",
            content: response,
            metadata: {
              conversationId: result.conversation_id,
              durationSeconds: result.duration_seconds,
              usage: result.usage,
            },
          });
        }
        continue;
      }

      // `init` and anything a later version adds: recorded, not interpreted.
      // Guessing at an unknown event's meaning is how a stream parser starts
      // reporting fiction.
      if (parsed.event === "init") continue;
      events.push({ type: "output", content: trimmed });
    }

    return events;
  },

  async testEnvironment(): Promise<{ ok: boolean; version?: string; message: string }> {
    try {
      const { stdout } = await execFileAsync("agy", ["--version"], { timeout: 5000 });
      return { ok: true, version: stdout.trim(), message: "agy CLI found" };
    } catch {
      return { ok: false, message: "agy CLI not found in PATH" };
    }
  },
};
