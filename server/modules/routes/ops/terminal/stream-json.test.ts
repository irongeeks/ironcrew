import { describe, expect, it } from "vitest";
import { prettyStreamJson } from "./pretty-stream-json.ts";
import { buildTerminalProgressHints } from "./progress-hints.ts";

const jsonl = (...events: unknown[]) => events.map((event) => JSON.stringify(event)).join("\n");

describe("terminal provider JSON boundaries", () => {
  it("keeps valid Claude text after malformed content entries", () => {
    expect(
      prettyStreamJson(jsonl({ type: "assistant", message: { content: [null, 1, { type: "text", text: "Ready" }] } })),
    ).toBe("Ready");
  });

  it("extracts OpenClaw text from mixed payload entries", () => {
    expect(prettyStreamJson(JSON.stringify({ payloads: [null, [], { text: "Completed" }] }, null, 2))).toBe(
      "Completed",
    );
  });

  it("does not repeat Claude text received as deltas and a completed message", () => {
    expect(
      prettyStreamJson(
        jsonl(
          {
            type: "stream_event",
            event: { type: "content_block_delta", delta: { type: "text_delta", text: "Ready" } },
          },
          { type: "assistant", message: { content: [{ type: "text", text: "Ready" }] } },
        ),
      ),
    ).toBe("Ready");
  });

  it("retains the reasoning visibility setting for OpenCode", () => {
    const raw = jsonl({ type: "reasoning", part: { text: "Checking" } }, { type: "text", part: { text: "Done" } });
    expect(prettyStreamJson(raw)).toBe("Done");
    expect(prettyStreamJson(raw, { includeReasoning: true })).toContain("Checking");
  });

  it("correlates Claude tool results after malformed content entries", () => {
    const hints = buildTerminalProgressHints(
      jsonl(
        {
          type: "assistant",
          message: {
            content: [null, { type: "tool_use", id: "read-1", name: "Read", input: { file_path: "/repo/README.md" } }],
          },
        },
        {
          type: "user",
          message: {
            content: [null, { type: "tool_result", tool_use_id: "read-1", content: [null, { text: "Read complete" }] }],
          },
        },
      ),
    );
    expect(hints.hints).toEqual([
      expect.objectContaining({ phase: "use", tool: "Read", file_path: "/repo/README.md" }),
      expect.objectContaining({ phase: "ok", tool: "Read", file_path: "/repo/README.md", summary: "Read complete" }),
    ]);
  });

  it("retains valid Codex file changes beside malformed entries", () => {
    expect(
      buildTerminalProgressHints(
        jsonl({ type: "item.completed", item: { type: "file_change", changes: [null, 5, { path: "/repo/app.ts" }] } }),
      ).hints,
    ).toEqual([{ phase: "ok", tool: "Edit", summary: "/repo/app.ts", file_path: "/repo/app.ts" }]);
  });

  it("normalizes OpenCode camel-case paths and de-duplicates completed results", () => {
    const event = {
      type: "tool_use",
      part: {
        type: "tool",
        tool: "read",
        callID: "call-1",
        state: { status: "completed", input: { filePath: "/repo/app.ts" }, output: "Read complete" },
      },
    };
    const hints = buildTerminalProgressHints(jsonl(event, event));
    expect(hints.hints).toHaveLength(2);
    expect(hints.hints[1]).toEqual({ phase: "ok", tool: "Read", summary: "Read complete", file_path: "/repo/app.ts" });
  });

  it("ignores malformed envelopes without losing later events", () => {
    const raw = jsonl(
      { type: "stream_event", event: null },
      { type: "assistant", message: "invalid" },
      { type: "item.completed", item: { type: "agent_message", text: "Recovered" } },
    );
    expect(prettyStreamJson(raw)).toBe("Recovered");
    expect(buildTerminalProgressHints(raw).hints).toEqual([]);
  });
});
