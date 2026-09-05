import { describe, expect, it } from "vitest";
import { NativeCliParser } from "./cli-native-events.ts";

describe("native CLI normalization", () => {
  it("publishes the session before a Claude result and does not duplicate streamed snapshots", () => {
    const parser = new NativeCliParser("claude");
    expect(parser.parse(JSON.stringify({ type: "system", session_id: "session-1" }))).toEqual([
      { type: "run.started", payload: { sessionRef: "session-1", phase: "session_initialized", runtime: "claude" } },
    ]);
    expect(
      parser.parse(JSON.stringify({ type: "stream_event", event: { delta: { type: "text_delta", text: "Hallo" } } })),
    ).toEqual([{ type: "message.delta", payload: { text: "Hallo" } }]);
    expect(
      parser.parse(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Hallo" }] } })),
    ).toEqual([]);
  });
  it("maps Claude tool requests and failures", () => {
    const parser = new NativeCliParser("claude");
    const requested = parser.parse(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "README.md" } }] },
      }),
    )!;
    expect(requested.map((event) => event.type)).toEqual(["tool.requested", "tool.started"]);
    expect(
      parser.parse(
        JSON.stringify({
          type: "user",
          message: {
            content: [{ type: "tool_result", tool_use_id: "tool-1", is_error: true, content: "No such file" }],
          },
        }),
      ),
    ).toEqual([{ type: "tool.failed", payload: { id: "tool-1", result: "No such file" } }]);
  });
  it("maps Codex command lifecycle and actual token usage", () => {
    const parser = new NativeCliParser("codex");
    const item = { id: "command-1", type: "command_execution", command: "git status" };
    expect(parser.parse(JSON.stringify({ type: "item.started", item }))!.map((event) => event.type)).toEqual([
      "tool.requested",
      "tool.started",
    ]);
    expect(parser.parse(JSON.stringify({ type: "item.completed", item: { ...item, status: "failed" } }))![0].type).toBe(
      "tool.failed",
    );
    expect(
      parser.parse(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 37, output_tokens: 11 } })),
    ).toEqual([{ type: "usage.updated", payload: { inputTokens: 37, outputTokens: 11, costMicros: 0 } }]);
  });
  it("streams Antigravity text without duplicating its result", () => {
    const parser = new NativeCliParser("antigravity");
    expect(
      parser.parse(JSON.stringify({ event: "init", init: { conversation_id: "conversation-1" } }))![0].payload
        .sessionRef,
    ).toBe("conversation-1");
    expect(
      parser.parse(JSON.stringify({ event: "step_update", step_update: { text_delta: "Fertig" } }))![0].payload.text,
    ).toBe("Fertig");
    expect(
      parser.parse(JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "Fertig" } })),
    ).toEqual([]);
  });
  it("leaves legacy text to the adapter and rejects option-shaped session references", () => {
    const parser = new NativeCliParser("claude");
    expect(parser.parse("plain text")).toBeNull();
    expect(parser.parse(JSON.stringify({ type: "system", session_id: "--last" }))).toEqual([]);
    expect(parser.sessionRef).toBeUndefined();
  });
});
