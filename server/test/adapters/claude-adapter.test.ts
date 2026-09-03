import { describe, it, expect } from "vitest";
import { claudeAdapter } from "../../adapters/claude.ts";

describe("claudeAdapter", () => {
  it("has correct providerType, transport, and promptDelivery", () => {
    expect(claudeAdapter.providerType).toBe("claude");
    expect(claudeAdapter.transport).toBe("cli");
    expect(claudeAdapter.promptDelivery).toBe("stdin");
  });

  it("supports token tracking", () => {
    expect(claudeAdapter.supportsTokenTracking).toBe(true);
  });

  describe("buildArgs()", () => {
    it("includes all required base flags", () => {
      const args = claudeAdapter.buildArgs({ prompt: "hello", workdir: "/tmp" });
      expect(args).toContain("claude");
      expect(args).toContain("--dangerously-skip-permissions");
      expect(args).toContain("--print");
      expect(args).toContain("--verbose");
      expect(args).toContain("--output-format=stream-json");
      expect(args).toContain("--include-partial-messages");
      expect(args).toContain("--max-turns");
      expect(args).toContain("200");
    });

    it("includes --model flag when model is provided", () => {
      const args = claudeAdapter.buildArgs({ prompt: "hello", workdir: "/tmp", model: "claude-opus-4-5" });
      expect(args).toContain("--model");
      expect(args).toContain("claude-opus-4-5");
    });

    it("does not include --model flag when model is absent", () => {
      const args = claudeAdapter.buildArgs({ prompt: "hello", workdir: "/tmp" });
      expect(args).not.toContain("--model");
    });
  });

  describe("detectSubtask()", () => {
    it("returns subtask info for tool_use with tool=Task", () => {
      const raw = JSON.stringify({
        type: "tool_use",
        tool: "Task",
        id: "tu_001",
        input: { description: "Write unit tests for the auth module" },
      });
      const result = claudeAdapter.detectSubtask!(raw);
      expect(result).not.toBeNull();
      expect(result!.title).toBe("Write unit tests for the auth module");
      expect(result!.description).toBe("Write unit tests for the auth module");
    });

    it("falls back to input.prompt when description is missing", () => {
      const raw = JSON.stringify({
        type: "tool_use",
        tool: "Task",
        id: "tu_002",
        input: { prompt: "Refactor the database layer\nSecond line" },
      });
      const result = claudeAdapter.detectSubtask!(raw);
      expect(result).not.toBeNull();
      expect(result!.title).toBe("Refactor the database layer");
    });

    it("returns null for non-task tool_use", () => {
      const raw = JSON.stringify({ type: "tool_use", tool: "Bash", id: "tu_003", input: {} });
      expect(claudeAdapter.detectSubtask!(raw)).toBeNull();
    });

    it("returns null for non-JSON input", () => {
      expect(claudeAdapter.detectSubtask!("plain text")).toBeNull();
    });
  });

  describe("detectSubtaskDone()", () => {
    it("returns id for tool_result with tool=Task", () => {
      const raw = JSON.stringify({ type: "tool_result", tool: "Task", id: "tu_001" });
      const result = claudeAdapter.detectSubtaskDone!(raw);
      expect(result).not.toBeNull();
      expect(result!.id).toBe("tu_001");
    });

    it("returns null for tool_result with different tool", () => {
      const raw = JSON.stringify({ type: "tool_result", tool: "Bash", id: "tu_002" });
      expect(claudeAdapter.detectSubtaskDone!(raw)).toBeNull();
    });

    it("returns null for non-JSON input", () => {
      expect(claudeAdapter.detectSubtaskDone!("not json")).toBeNull();
    });
  });

  describe("parseStreamChunk()", () => {
    it("emits subtask_created event for tool_use Task", () => {
      const line = JSON.stringify({
        type: "tool_use",
        tool: "Task",
        id: "tu_001",
        input: { description: "Do something" },
      });
      const events = claudeAdapter.parseStreamChunk(line + "\n");
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("subtask_created");
      expect(events[0].content).toBe("Do something");
      expect(events[0].metadata?.id).toBe("tu_001");
    });

    it("emits subtask_done event for tool_result Task", () => {
      const line = JSON.stringify({ type: "tool_result", tool: "Task", id: "tu_001" });
      const events = claudeAdapter.parseStreamChunk(line + "\n");
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("subtask_done");
      expect(events[0].metadata?.id).toBe("tu_001");
    });

    it("emits output event for plain text lines", () => {
      const events = claudeAdapter.parseStreamChunk("some plain output\n");
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("output");
      expect(events[0].content).toBe("some plain output");
    });

    it("handles multiple lines in one chunk", () => {
      const chunk = [
        JSON.stringify({ type: "tool_use", tool: "Task", id: "tu_1", input: { description: "Task A" } }),
        JSON.stringify({ type: "tool_result", tool: "Task", id: "tu_1" }),
      ].join("\n");
      const events = claudeAdapter.parseStreamChunk(chunk);
      expect(events).toHaveLength(2);
      expect(events[0].type).toBe("subtask_created");
      expect(events[1].type).toBe("subtask_done");
    });

    it("emits token_usage event for result message with token data", () => {
      const line = JSON.stringify({
        type: "result",
        subtype: "success",
        cost_usd: 0.05,
        is_error: false,
        duration_ms: 12345,
        duration_api_ms: 10000,
        num_turns: 3,
        result: "Task completed",
        session_id: "sess_001",
        total_cost_usd: 0.15,
        usage: {
          input_tokens: 1500,
          output_tokens: 800,
          cache_read_input_tokens: 200,
          cache_creation_input_tokens: 50,
        },
      });
      const events = claudeAdapter.parseStreamChunk(line + "\n");
      const tokenEvent = events.find((e) => e.type === "token_usage");
      expect(tokenEvent).toBeDefined();
      expect(tokenEvent!.metadata).toEqual({
        input_tokens: 1500,
        output_tokens: 800,
        cache_read_tokens: 200,
        cache_write_tokens: 50,
        model: undefined,
      });
    });

    it("emits token_usage event with model when present in result", () => {
      const line = JSON.stringify({
        type: "result",
        model: "claude-opus-4-5",
        usage: {
          input_tokens: 500,
          output_tokens: 300,
        },
      });
      const events = claudeAdapter.parseStreamChunk(line + "\n");
      const tokenEvent = events.find((e) => e.type === "token_usage");
      expect(tokenEvent).toBeDefined();
      expect(tokenEvent!.metadata?.model).toBe("claude-opus-4-5");
      expect(tokenEvent!.metadata?.input_tokens).toBe(500);
      expect(tokenEvent!.metadata?.output_tokens).toBe(300);
      expect(tokenEvent!.metadata?.cache_read_tokens).toBe(0);
      expect(tokenEvent!.metadata?.cache_write_tokens).toBe(0);
    });

    it("does not emit token_usage for result without usage field", () => {
      const line = JSON.stringify({
        type: "result",
        subtype: "success",
        result: "done",
      });
      const events = claudeAdapter.parseStreamChunk(line + "\n");
      expect(events.find((e) => e.type === "token_usage")).toBeUndefined();
    });
  });
});
