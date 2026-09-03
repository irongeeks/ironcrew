export type TerminalProgressHintPhase = "use" | "ok" | "error";

export interface TerminalProgressHintItem {
  phase: TerminalProgressHintPhase;
  tool: string;
  summary: string;
  file_path: string | null;
}

interface StreamToolUseState {
  tool_use_id: string;
  tool: string;
  initial_input: any;
  input_json: string;
}

function clipHint(text: string, max = 160): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1).trimEnd()}…`;
}

function pickFirstNonEmptyLine(value: string): string {
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

function extractPathLikeToken(text: string): string | null {
  const m = text.match(/(?:[A-Za-z]:\\|\/)[^\s"'`<>|]+/);
  return m ? m[0] : null;
}

function normalizeShellCommand(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) return "";
  const wrapped = trimmed.match(/^(?:\S*\/)?(?:bash|zsh|sh)\s+-lc\s+([\s\S]+)$/);
  if (!wrapped) return trimmed;
  let inner = wrapped[1].trim();
  if ((inner.startsWith("'") && inner.endsWith("'")) || (inner.startsWith('"') && inner.endsWith('"'))) {
    inner = inner.slice(1, -1);
  }
  return inner.trim() || trimmed;
}

function extractToolUseFilePath(toolName: string, input: any): string | null {
  if (!input || typeof input !== "object") return null;
  if (typeof input.file_path === "string" && input.file_path.trim()) {
    return input.file_path.trim();
  }
  if (typeof input.path === "string" && input.path.trim()) {
    return input.path.trim();
  }
  if (Array.isArray(input.paths)) {
    const first = input.paths.find((v: unknown) => typeof v === "string" && v.trim());
    if (typeof first === "string") return first.trim();
  }
  if (toolName === "Bash" && typeof input.command === "string") {
    const normalizedCommand = normalizeShellCommand(input.command);
    return extractPathLikeToken(normalizedCommand) || extractPathLikeToken(input.command) || null;
  }
  return null;
}

function summarizeToolUse(toolName: string, input: any): string {
  if (!input || typeof input !== "object") return toolName;
  if (typeof input.description === "string" && input.description.trim()) {
    return clipHint(input.description, 180);
  }
  if (typeof input.file_path === "string" && input.file_path.trim()) {
    return clipHint(input.file_path, 180);
  }
  if (typeof input.path === "string" && input.path.trim()) {
    return clipHint(input.path, 180);
  }
  if (typeof input.command === "string" && input.command.trim()) {
    const normalizedCommand = normalizeShellCommand(input.command);
    return clipHint(normalizedCommand || input.command, 180);
  }
  if (typeof input.prompt === "string" && input.prompt.trim()) {
    return clipHint(input.prompt, 180);
  }
  return toolName;
}

function summarizeToolResult(content: unknown): string {
  if (typeof content === "string") {
    return clipHint(pickFirstNonEmptyLine(content), 180);
  }
  if (Array.isArray(content)) {
    for (const item of content) {
      if (typeof item === "string" && item.trim()) {
        return clipHint(pickFirstNonEmptyLine(item), 180);
      }
      if (item && typeof item === "object") {
        const text = (item as any).text;
        if (typeof text === "string" && text.trim()) {
          return clipHint(pickFirstNonEmptyLine(text), 180);
        }
      }
    }
  }
  if (content && typeof content === "object") {
    const obj = content as Record<string, unknown>;
    for (const key of ["message", "error", "output", "stdout", "stderr", "text"]) {
      const value = obj[key];
      if (typeof value === "string" && value.trim()) {
        return clipHint(pickFirstNonEmptyLine(value), 180);
      }
    }
  }
  return "";
}

function parseJsonObject(value: string): any | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function capitalizeToolName(name: string): string {
  if (!name) return "Tool";
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function normalizeOpencodeInput(input: any): any {
  if (!input || typeof input !== "object") return input;
  const normalized: any = { ...input };
  if (typeof input.filePath === "string" && !input.file_path) {
    normalized.file_path = input.filePath;
  }
  return normalized;
}

export function buildTerminalProgressHints(
  raw: string,
  maxHints = 14,
): {
  current_file: string | null;
  hints: TerminalProgressHintItem[];
  ok_items: string[];
} {
  const toolUseMeta = new Map<string, { tool: string; summary: string; file_path: string | null }>();
  const streamToolUseByIndex = new Map<number, StreamToolUseState>();
  const emittedToolUseIds = new Set<string>();
  const emittedToolResultIds = new Set<string>();
  const hints: TerminalProgressHintItem[] = [];

  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || !t.startsWith("{")) continue;
    try {
      const j: any = JSON.parse(t);

      if (j.type === "stream_event") {
        const ev = j.event;
        if (ev?.type === "content_block_start" && ev?.content_block?.type === "tool_use") {
          const idx = Number(ev.index);
          if (Number.isFinite(idx)) {
            streamToolUseByIndex.set(idx, {
              tool_use_id: String(ev.content_block.id || ""),
              tool: String(ev.content_block.name || "Tool"),
              initial_input:
                ev.content_block.input && typeof ev.content_block.input === "object" ? ev.content_block.input : {},
              input_json: "",
            });
          }
          continue;
        }
        if (ev?.type === "content_block_delta" && ev?.delta?.type === "input_json_delta") {
          const idx = Number(ev.index);
          if (Number.isFinite(idx)) {
            const state = streamToolUseByIndex.get(idx);
            if (state) {
              state.input_json += String(ev.delta.partial_json ?? "");
            }
          }
          continue;
        }
        if (ev?.type === "content_block_stop") {
          const idx = Number(ev.index);
          if (Number.isFinite(idx)) {
            const state = streamToolUseByIndex.get(idx);
            if (state) {
              const parsedInput = parseJsonObject(state.input_json);
              const input =
                parsedInput && typeof state.initial_input === "object"
                  ? { ...state.initial_input, ...parsedInput }
                  : parsedInput || state.initial_input || {};
              const summary = summarizeToolUse(state.tool, input);
              const filePath = extractToolUseFilePath(state.tool, input);
              if (state.tool_use_id && !emittedToolUseIds.has(state.tool_use_id)) {
                emittedToolUseIds.add(state.tool_use_id);
                toolUseMeta.set(state.tool_use_id, { tool: state.tool, summary, file_path: filePath });
                hints.push({
                  phase: "use",
                  tool: state.tool,
                  summary,
                  file_path: filePath,
                });
              }
              streamToolUseByIndex.delete(idx);
            }
          }
          continue;
        }
      }

      if (j.type === "assistant" && Array.isArray(j.message?.content)) {
        for (const block of j.message.content) {
          if (block?.type !== "tool_use") continue;
          const toolUseId = String(block.id || "");
          if (toolUseId && emittedToolUseIds.has(toolUseId)) continue;
          const tool = String(block.name || "Tool");
          const summary = summarizeToolUse(tool, block.input);
          const filePath = extractToolUseFilePath(tool, block.input);
          if (toolUseId) {
            emittedToolUseIds.add(toolUseId);
            toolUseMeta.set(toolUseId, { tool, summary, file_path: filePath });
          }
          hints.push({
            phase: "use",
            tool,
            summary,
            file_path: filePath,
          });
        }
        continue;
      }

      if (j.type === "user" && Array.isArray(j.message?.content)) {
        for (const block of j.message.content) {
          if (block?.type !== "tool_result") continue;
          const toolUseId = String(block.tool_use_id || "");
          const meta = toolUseMeta.get(toolUseId);
          const phase: TerminalProgressHintPhase = block.is_error ? "error" : "ok";
          const summary = summarizeToolResult(block.content) || meta?.summary || toolUseId || "tool result";
          hints.push({
            phase,
            tool: meta?.tool || "Tool",
            summary,
            file_path: meta?.file_path || null,
          });
        }
        continue;
      }

      if (j.type === "item.started" && j.item && typeof j.item === "object") {
        const item = j.item as any;
        if (item.type === "command_execution" || item.type === "collab_tool_call") {
          const toolUseIdRaw = String(item.id || "");
          const toolUseId = toolUseIdRaw ? `codex:${toolUseIdRaw}` : "";
          const tool = item.type === "command_execution" ? "Bash" : String(item.tool || "Tool");
          const input =
            item.type === "command_execution"
              ? { command: String(item.command || "") }
              : item.arguments && typeof item.arguments === "object"
                ? item.arguments
                : item.input && typeof item.input === "object"
                  ? item.input
                  : {};
          const summary = summarizeToolUse(tool, input);
          const filePath = extractToolUseFilePath(tool, input);
          if (toolUseId && emittedToolUseIds.has(toolUseId)) {
            continue;
          }
          if (toolUseId) {
            emittedToolUseIds.add(toolUseId);
            toolUseMeta.set(toolUseId, { tool, summary, file_path: filePath });
          }
          hints.push({
            phase: "use",
            tool,
            summary,
            file_path: filePath,
          });
          continue;
        }
      }

      if (j.type === "item.completed" && j.item && typeof j.item === "object") {
        const item = j.item as any;
        if (item.type === "command_execution" || item.type === "collab_tool_call") {
          const toolUseIdRaw = String(item.id || "");
          const toolUseId = toolUseIdRaw ? `codex:${toolUseIdRaw}` : "";
          const meta = toolUseId ? toolUseMeta.get(toolUseId) : undefined;
          const tool = meta?.tool || (item.type === "command_execution" ? "Bash" : String(item.tool || "Tool"));
          const fallbackInput =
            item.type === "command_execution"
              ? { command: String(item.command || "") }
              : item.arguments && typeof item.arguments === "object"
                ? item.arguments
                : item.input && typeof item.input === "object"
                  ? item.input
                  : {};
          const isError =
            item.status === "failed" ||
            item.status === "error" ||
            (typeof item.exit_code === "number" && item.exit_code !== 0);
          const phase: TerminalProgressHintPhase = isError ? "error" : "ok";
          const summary =
            summarizeToolResult(item.aggregated_output) ||
            summarizeToolResult(item.output) ||
            summarizeToolResult(item.error) ||
            meta?.summary ||
            summarizeToolUse(tool, fallbackInput) ||
            "tool result";
          const filePath = meta?.file_path || extractToolUseFilePath(tool, fallbackInput);
          hints.push({
            phase,
            tool,
            summary,
            file_path: filePath || null,
          });
          continue;
        }
        if (item.type === "file_change" && Array.isArray(item.changes)) {
          const changedPaths = item.changes
            .map((row: any) => (typeof row?.path === "string" ? row.path.trim() : ""))
            .filter(Boolean);
          if (changedPaths.length > 0) {
            const phase: TerminalProgressHintPhase =
              item.status === "failed" || item.status === "error" ? "error" : "ok";
            hints.push({
              phase,
              tool: "Edit",
              summary: clipHint(changedPaths.slice(0, 2).join(", "), 180),
              file_path: changedPaths[0] || null,
            });
          }
          continue;
        }
      }

      if (j.type === "tool_use" && j.part?.type === "tool") {
        const part = j.part as any;
        const rawCallId =
          typeof part.callID === "string"
            ? part.callID.trim()
            : typeof part.callId === "string"
              ? part.callId.trim()
              : typeof part.call_id === "string"
                ? part.call_id.trim()
                : "";
        const toolUseId = rawCallId ? `opencode:${rawCallId}` : "";
        const tool = capitalizeToolName(String(part.tool || "Tool"));
        const input = normalizeOpencodeInput(part.state?.input);
        const summary = summarizeToolUse(tool, input);
        const filePath = extractToolUseFilePath(tool, input);
        const status = part.state?.status;
        const statusKey = toolUseId && (status === "completed" || status === "error") ? `${toolUseId}:${status}` : "";

        if (toolUseId && emittedToolUseIds.has(toolUseId)) {
          if (statusKey && !emittedToolResultIds.has(statusKey)) {
            const isError = status === "error";
            const resultSummary =
              summarizeToolResult(part.state?.output) || summarizeToolResult(part.state?.error) || summary;
            emittedToolResultIds.add(statusKey);
            hints.push({
              phase: isError ? "error" : "ok",
              tool,
              summary: resultSummary,
              file_path: filePath,
            });
          }
          continue;
        }
        if (toolUseId) {
          emittedToolUseIds.add(toolUseId);
          toolUseMeta.set(toolUseId, { tool, summary, file_path: filePath });
        }

        hints.push({ phase: "use", tool, summary, file_path: filePath });

        if (status === "completed" || status === "error") {
          const isError = status === "error";
          const resultSummary =
            summarizeToolResult(part.state?.output) || summarizeToolResult(part.state?.error) || summary;
          if (statusKey) emittedToolResultIds.add(statusKey);
          hints.push({
            phase: isError ? "error" : "ok",
            tool,
            summary: resultSummary,
            file_path: filePath,
          });
        }
        continue;
      }

      if (j.type === "tool_use" && typeof j.tool_name === "string") {
        const rawToolId = typeof j.tool_id === "string" ? j.tool_id.trim() : "";
        const toolUseId = rawToolId ? `gemini:${rawToolId}` : "";
        const tool = String(j.tool_name || "Tool");
        const input = j.parameters && typeof j.parameters === "object" ? j.parameters : {};
        const summary = summarizeToolUse(tool, input);
        const filePath = extractToolUseFilePath(tool, input);
        if (toolUseId && emittedToolUseIds.has(toolUseId)) {
          continue;
        }
        if (toolUseId) {
          emittedToolUseIds.add(toolUseId);
          toolUseMeta.set(toolUseId, { tool, summary, file_path: filePath });
        }
        hints.push({
          phase: "use",
          tool,
          summary,
          file_path: filePath,
        });
        continue;
      }

      if (j.type === "tool_result") {
        const rawToolId = typeof j.tool_id === "string" ? j.tool_id.trim() : "";
        const toolUseId = rawToolId ? `gemini:${rawToolId}` : "";
        const meta = toolUseId ? toolUseMeta.get(toolUseId) : undefined;
        const status = typeof j.status === "string" ? j.status.toLowerCase() : "";
        const phase: TerminalProgressHintPhase =
          status === "error" || status === "failed" || j.is_error === true ? "error" : "ok";
        const summary =
          summarizeToolResult(j.output) || summarizeToolResult(j.error) || meta?.summary || rawToolId || "tool result";
        hints.push({
          phase,
          tool: meta?.tool || "Tool",
          summary,
          file_path: meta?.file_path || null,
        });
        continue;
      }
    } catch {
      // malformed stream-json line
    }
  }

  const compacted: TerminalProgressHintItem[] = [];
  for (const row of hints.slice(-Math.max(maxHints * 3, 24))) {
    const prev = compacted[compacted.length - 1];
    if (
      prev &&
      prev.phase === row.phase &&
      prev.tool === row.tool &&
      prev.summary === row.summary &&
      prev.file_path === row.file_path
    ) {
      continue;
    }
    compacted.push(row);
  }

  const recent = compacted.slice(-maxHints);
  const latestFile = [...recent].reverse().find((r) => !!r.file_path)?.file_path ?? null;
  const okItems = [
    ...new Set(
      recent
        .filter((r) => r.phase === "ok")
        .map((r) => clipHint(r.summary, 120))
        .filter(Boolean),
    ),
  ].slice(-4);

  return {
    current_file: latestFile,
    hints: recent,
    ok_items: okItems,
  };
}
