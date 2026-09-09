import { isRecord, recordOrEmpty } from "../../shared/json-record.ts";
export function prettyStreamJson(raw: string, opts: { includeReasoning?: boolean } = {}): string {
  // OpenClaw: output is pretty-printed multi-line JSON with payloads array
  // Must handle before the line-by-line JSONL loop
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const whole = recordOrEmpty(JSON.parse(trimmed));
      if (Array.isArray(whole.payloads)) {
        const texts: string[] = [];
        for (const payload of whole.payloads.filter(isRecord)) {
          if (payload && typeof payload.text === "string" && payload.text.trim()) {
            texts.push(payload.text.trim());
          }
        }
        if (texts.length > 0) return texts.join("\n");
      }
    } catch {
      // not a single JSON object — fall through to line-by-line parsing
    }
  }

  const chunks: string[] = [];
  let sawJson = false;
  let sawClaudeTextDelta = false;
  const includeReasoning = opts.includeReasoning === true;
  const pushReasoningChunk = (text: string): void => {
    if (!text) return;
    pushMessageChunk(`[reasoning] ${text}`);
  };
  const pushMessageChunk = (text: string): void => {
    if (!text) return;
    if (chunks.length > 0 && !chunks[chunks.length - 1].endsWith("\n")) {
      chunks.push("\n");
    }
    chunks.push(text);
    if (!text.endsWith("\n")) {
      chunks.push("\n");
    }
  };

  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (!t.startsWith("{")) continue;

    try {
      const j = recordOrEmpty(JSON.parse(t));
      const message = recordOrEmpty(j.message);
      const part = recordOrEmpty(j.part);
      sawJson = true;

      if (j.type === "stream_event") {
        const ev = recordOrEmpty(j.event);
        const delta = recordOrEmpty(ev.delta);
        const contentBlock = recordOrEmpty(ev.content_block);
        if (ev?.type === "content_block_delta" && delta.type === "text_delta") {
          sawClaudeTextDelta = true;
          chunks.push(String(delta.text ?? ""));
          continue;
        }
        if (ev?.type === "content_block_start" && contentBlock.type === "text" && contentBlock.text) {
          chunks.push(String(contentBlock.text));
          continue;
        }
        continue;
      }

      if (j.type === "assistant" && Array.isArray(message.content)) {
        let assistantText = "";
        for (const block of (message.content as unknown[]).filter(isRecord)) {
          if (block.type === "text" && block.text && !sawClaudeTextDelta) {
            assistantText += String(block.text);
          }
        }
        pushMessageChunk(assistantText);
        continue;
      }

      if (j.type === "result" && j.result) {
        pushMessageChunk(String(j.result));
        continue;
      }

      if (j.type === "message" && j.role === "assistant" && j.content) {
        pushMessageChunk(String(j.content));
        continue;
      }

      if (j.type === "item.completed" && j.item) {
        const item = recordOrEmpty(j.item);
        if (item.type === "agent_message" && item.text) {
          pushMessageChunk(String(item.text));
        }
        continue;
      }

      if (j.type === "text") {
        if (part.type === "reasoning" || part.type === "thinking") {
          if (!includeReasoning) continue;
          const reasoningVal = typeof part.text === "string" ? part.text : typeof j.text === "string" ? j.text : "";
          if (reasoningVal) pushReasoningChunk(String(reasoningVal));
          continue;
        }
        const textVal = typeof part.text === "string" ? part.text : typeof j.text === "string" ? j.text : "";
        if (textVal) chunks.push(String(textVal));
        continue;
      }

      if (j.type === "thinking" || j.type === "reasoning") {
        if (includeReasoning) {
          const reasoningVal =
            typeof part.text === "string"
              ? part.text
              : typeof j.text === "string"
                ? j.text
                : typeof j.content === "string"
                  ? j.content
                  : "";
          if (reasoningVal) pushReasoningChunk(String(reasoningVal));
        }
        continue;
      }

      if (j.type === "content" && (j.content || j.text)) {
        chunks.push(String(j.content ?? j.text));
        continue;
      }

      if (j.type === "step_finish" || j.type === "step-finish") {
        continue;
      }
      if ((j.type === "tool_use" || j.type === "tool_result") && j.part) {
        continue;
      }

      if (j.role === "assistant") {
        if (typeof j.content === "string") {
          pushMessageChunk(j.content);
        } else if (Array.isArray(j.content)) {
          const parts: string[] = [];
          for (const part of j.content as unknown[]) {
            if (typeof part === "string") {
              parts.push(part);
            } else if (isRecord(part) && typeof part.text === "string") {
              parts.push(part.text);
            }
          }
          pushMessageChunk(parts.join("\n"));
        }
        continue;
      }

      if (typeof j.text === "string" && (j.type === "assistant_message" || j.type === "output_text")) {
        pushMessageChunk(j.text);
        continue;
      }

      // OpenClaw single-line JSONL fallback (payloads format)
      if (Array.isArray(j.payloads)) {
        for (const payload of j.payloads.filter(isRecord)) {
          if (payload && typeof payload.text === "string" && payload.text.trim()) {
            pushMessageChunk(payload.text);
          }
        }
        continue;
      }
    } catch {
      // malformed stream-json line
    }
  }

  if (!sawJson) {
    return raw.trim();
  }

  const stitched = chunks.join("");
  const normalized = stitched
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

  return normalized;
}
