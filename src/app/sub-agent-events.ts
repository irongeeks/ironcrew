import { MAX_SUBAGENT_TASK_LABEL_CHARS } from "./constants";
import type { CliSubAgentEvent } from "./types";

const SUB_AGENT_PARSE_MARKERS = [
  '"Task"',
  '"spawn_agent"',
  '"close_agent"',
  '"tool_use"',
  '"tool_result"',
  '"collab_tool_call"',
  '"item.started"',
  '"item.completed"',
  '"tool_name"',
  '"tool_id"',
  '"callID"',
] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const items: string[] = [];
  for (const raw of value) {
    const parsed = asNonEmptyString(raw);
    if (parsed) items.push(parsed);
  }
  return items;
}

function isSubAgentToolName(value: unknown): boolean {
  const name = asNonEmptyString(value)?.toLowerCase();
  return name === "task" || name === "spawn_agent" || name === "spawnagent";
}

function extractTaskLabel(value: unknown): string | null {
  if (typeof value === "string") {
    const firstLine = value.split("\n")[0]?.trim() ?? "";
    return firstLine ? firstLine.slice(0, MAX_SUBAGENT_TASK_LABEL_CHARS) : null;
  }
  const obj = asRecord(value);
  if (!obj) return null;
  const raw =
    asNonEmptyString(obj.description) ??
    asNonEmptyString(obj.prompt) ??
    asNonEmptyString(obj.task) ??
    asNonEmptyString(obj.message) ??
    asNonEmptyString(obj.command);
  if (!raw) return null;
  const firstLine = raw.split("\n")[0]?.trim() ?? "";
  return firstLine ? firstLine.slice(0, MAX_SUBAGENT_TASK_LABEL_CHARS) : null;
}

export function shouldParseCliChunkForSubAgents(chunk: string): boolean {
  for (const marker of SUB_AGENT_PARSE_MARKERS) {
    if (chunk.includes(marker)) return true;
  }
  return false;
}

export function parseCliSubAgentEvents(json: Record<string, unknown>): CliSubAgentEvent[] {
  const events: CliSubAgentEvent[] = [];
  const type = asNonEmptyString(json.type);
  if (!type) return events;

  if (type === "stream_event") {
    const event = asRecord(json.event);
    if (!event) return events;
    if (asNonEmptyString(event.type) === "content_block_start") {
      const block = asRecord(event.content_block);
      if (block && asNonEmptyString(block.type) === "tool_use" && isSubAgentToolName(block.name)) {
        const id = asNonEmptyString(block.id);
        if (id) events.push({ kind: "spawn", id, task: extractTaskLabel(block.input) });
      }
    }
    return events;
  }

  if (type === "assistant") {
    const message = asRecord(json.message);
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const blockRaw of content) {
      const block = asRecord(blockRaw);
      if (!block || asNonEmptyString(block.type) !== "tool_use" || !isSubAgentToolName(block.name)) continue;
      const id = asNonEmptyString(block.id);
      if (id) events.push({ kind: "spawn", id, task: extractTaskLabel(block.input) });
    }
    return events;
  }

  if (type === "user") {
    const message = asRecord(json.message);
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const blockRaw of content) {
      const block = asRecord(blockRaw);
      if (!block || asNonEmptyString(block.type) !== "tool_result") continue;
      const toolUseId = asNonEmptyString(block.tool_use_id);
      if (toolUseId) events.push({ kind: "done", id: toolUseId });
    }
    return events;
  }

  if (type === "item.started" || type === "item.completed") {
    const item = asRecord(json.item);
    if (!item || asNonEmptyString(item.type) !== "collab_tool_call") return events;
    const tool = asNonEmptyString(item.tool)?.toLowerCase();

    if (tool && isSubAgentToolName(tool)) {
      const itemId = asNonEmptyString(item.id);
      if (itemId) {
        const subAgentId = `codex:${itemId}`;
        const task = extractTaskLabel(item.prompt) ?? extractTaskLabel(item.arguments) ?? extractTaskLabel(item.input);
        events.push({ kind: "spawn", id: subAgentId, task });
        if (type === "item.completed") {
          for (const threadId of asStringArray(item.receiver_thread_ids)) {
            events.push({ kind: "bind_thread", threadId, subAgentId });
          }
        }
      }
      return events;
    }

    if (type === "item.completed" && tool === "close_agent") {
      for (const threadId of asStringArray(item.receiver_thread_ids)) {
        events.push({ kind: "close_thread", threadId });
      }
    }
    return events;
  }

  if (type === "tool_use") {
    const part = asRecord(json.part);
    if (part && asNonEmptyString(part.type) === "tool" && isSubAgentToolName(part.tool)) {
      const callId = asNonEmptyString(part.callID) ?? asNonEmptyString(part.callId) ?? asNonEmptyString(part.call_id);
      if (callId) {
        const subAgentId = `opencode:${callId}`;
        const partState = asRecord(part.state);
        const task = extractTaskLabel(partState?.input) ?? extractTaskLabel(part.input);
        events.push({ kind: "spawn", id: subAgentId, task });
        const status = asNonEmptyString(partState?.status)?.toLowerCase();
        if (status === "completed" || status === "error" || status === "failed") {
          events.push({ kind: "done", id: subAgentId });
        }
      }
      return events;
    }

    if (isSubAgentToolName(json.tool_name)) {
      const toolId = asNonEmptyString(json.tool_id);
      if (toolId) {
        events.push({
          kind: "spawn",
          id: `gemini:${toolId}`,
          task: extractTaskLabel(json.parameters),
        });
      }
      return events;
    }

    if (isSubAgentToolName(json.tool)) {
      const id = asNonEmptyString(json.id);
      if (id) {
        events.push({ kind: "spawn", id, task: extractTaskLabel(json.input) });
      }
    }
    return events;
  }

  if (type === "tool_result") {
    if (isSubAgentToolName(json.tool)) {
      const id = asNonEmptyString(json.id);
      if (id) events.push({ kind: "done", id });
    }
    const toolId = asNonEmptyString(json.tool_id);
    if (toolId) events.push({ kind: "done", id: `gemini:${toolId}` });
  }

  return events;
}
