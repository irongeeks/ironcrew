/** SSE framing per https://openrouter.ai/docs/api_reference/streaming.
 * Handles split UTF-8, CR/LF/CRLF, comments and multiline data. Incomplete
 * streams fail closed: tools never execute before a complete [DONE] frame.
 */
export async function* readOpenRouterStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  maxBytes = 8 * 1024 * 1024,
): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let data: string[] = [];
  let bytes = 0;
  let complete = false;
  const onAbort = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (!complete) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) throw new Error("OpenRouter-Antwort überschreitet das Größenlimit.");
      buffer += decoder.decode(next.value, { stream: true });
      while (true) {
        const ending = /\r\n|\r|\n/.exec(buffer);
        if (!ending || (ending[0] === "\r" && ending.index === buffer.length - 1)) break;
        const line = buffer.slice(0, ending.index);
        buffer = buffer.slice(ending.index + ending[0].length);
        if (line === "") {
          if (data.length === 0) continue;
          const payload = data.join("\n");
          data = [];
          if (payload === "[DONE]") {
            complete = true;
            break;
          }
          yield JSON.parse(payload) as unknown;
        } else if (line.startsWith("data:")) {
          data.push(line.slice(5).replace(/^ /, ""));
        }
      }
      if (buffer.length > 1024 * 1024 || data.join("\n").length > 1024 * 1024) {
        throw new Error("OpenRouter-SSE-Ereignis überschreitet das Größenlimit.");
      }
    }
    if (!complete) throw new Error("OpenRouter-Stream vor [DONE] abgebrochen.");
  } finally {
    signal.removeEventListener("abort", onAbort);
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}
