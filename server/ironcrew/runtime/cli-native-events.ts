/** Native structured output, beyond the upstream adapters' legacy fixtures.
 * Schemas: official Claude headless docs, Codex non-interactive JSONL docs,
 * Google Antigravity headless docs (links in CLI_RUNTIME_ACCEPTANCE.md).
 */
import type { RunEventType } from "./run-events.ts";
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as ObjectValue) : {};
export interface NativeCliEvent {
  type: RunEventType;
  payload: ObjectValue;
}
export class NativeCliParser {
  sessionRef?: string;
  private streamed = false;
  constructor(private readonly provider: string) {}
  parse(line: string): NativeCliEvent[] | null {
    let data: ObjectValue;
    try {
      data = object(JSON.parse(line));
    } catch {
      return null;
    }
    const events: NativeCliEvent[] = [];
    const result = object(data.result);
    const init = object(data.init);
    const session =
      data.session_id ?? data.thread_id ?? data.conversation_id ?? result.conversation_id ?? init.conversation_id;
    if (
      typeof session === "string" &&
      /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(session) &&
      this.sessionRef !== session
    ) {
      this.sessionRef = session;
      events.push({
        type: "run.started",
        payload: { sessionRef: session, phase: "session_initialized", runtime: this.provider },
      });
    }
    const text = (value: unknown) => {
      if (typeof value === "string" && value) events.push({ type: "message.delta", payload: { text: value } });
    };
    if (this.provider === "claude") {
      if (data.type === "system") return events;
      if (data.type === "stream_event") {
        const event = object(data.event);
        const delta = object(event.delta);
        if (delta.type === "text_delta") {
          this.streamed = true;
          text(delta.text);
        }
        return events;
      }
      if (data.type === "assistant" && Array.isArray(object(data.message).content)) {
        for (const raw of object(data.message).content as unknown[]) {
          const block = object(raw);
          if (block.type === "text" && !this.streamed) text(block.text);
          if (block.type === "tool_use") {
            const payload = { tool: block.name, id: block.id, args: block.input };
            events.push({ type: "tool.requested", payload }, { type: "tool.started", payload });
            if (block.name === "Task" || block.name === "Agent") events.push({ type: "subagent.spawned", payload });
          }
        }
        return events;
      }
      if (data.type === "user" && Array.isArray(object(data.message).content)) {
        for (const raw of object(data.message).content as unknown[]) {
          const block = object(raw);
          if (block.type === "tool_result")
            events.push({
              type: block.is_error ? "tool.failed" : "tool.completed",
              payload: { id: block.tool_use_id, result: block.content },
            });
        }
        return events;
      }
      if (data.type === "result" && data.is_error === true) {
        events.push({
          type: "run.failed",
          payload: {
            message: typeof data.result === "string" ? data.result : "CLI meldet einen fehlgeschlagenen Lauf.",
          },
        });
        return events;
      }
    }
    if (this.provider === "codex") {
      if (data.type === "thread.started" || data.type === "turn.started") return events;
      const item = object(data.item);
      if (data.type === "item.completed" && item.type === "agent_message") {
        text(item.text);
        return events;
      }
      if (
        (data.type === "item.started" || data.type === "item.completed") &&
        (item.type === "command_execution" || item.type === "mcp_tool_call" || item.type === "file_change")
      ) {
        const payload = {
          id: item.id,
          tool: item.type,
          command: item.command,
          output: item.aggregated_output,
          status: item.status,
        };
        if (data.type === "item.started")
          events.push({ type: "tool.requested", payload }, { type: "tool.started", payload });
        else events.push({ type: item.status === "failed" ? "tool.failed" : "tool.completed", payload });
        return events;
      }
      if (data.type === "turn.completed") {
        const usage = object(data.usage);
        events.push({
          type: "usage.updated",
          payload: {
            inputTokens: Number(usage.input_tokens ?? 0),
            outputTokens: Number(usage.output_tokens ?? 0),
            costMicros: 0,
          },
        });
        return events;
      }
      if (data.type === "turn.failed" || data.type === "error") {
        events.push({
          type: "run.failed",
          payload: { message: String(object(data.error).message ?? data.message ?? "Codex-Lauf fehlgeschlagen.") },
        });
        return events;
      }
    }
    if (this.provider === "antigravity") {
      if (data.event === "init") return events;
      if (data.event === "step_update" && typeof object(data.step_update).text_delta === "string") {
        this.streamed = true;
        text(object(data.step_update).text_delta);
        return events;
      }
      if (data.event === "result") {
        if (result.status !== undefined && result.status !== "SUCCESS")
          events.push({ type: "run.failed", payload: { message: String(result.response ?? result.status) } });
        else if (!this.streamed) text(result.response);
        return events;
      }
    }
    // Keep session metadata even when the legacy adapter handles this shape.
    return events.length ? events : null;
  }
}
