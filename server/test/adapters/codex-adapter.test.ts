import { describe, it, expect } from "vitest";
import { codexAdapter } from "../../adapters/codex.ts";

describe("codexAdapter", () => {
  it("has correct providerType, transport, and promptDelivery", () => {
    expect(codexAdapter.providerType).toBe("codex");
    expect(codexAdapter.transport).toBe("cli");
    expect(codexAdapter.promptDelivery).toBe("stdin");
  });

  describe("buildArgs()", () => {
    it("includes base flags: --enable multi_agent, sandboxed exec --json", () => {
      const args = codexAdapter.buildArgs({ prompt: "hello", workdir: "/tmp" });
      expect(args).toContain("codex");
      expect(args).toContain("--enable");
      expect(args).toContain("multi_agent");
      // Iron Command: --yolo is no longer a base flag; default is a read-only sandbox.
      expect(args).not.toContain("--yolo");
      expect(args).toContain("--sandbox");
      expect(args).toContain("read-only");
      expect(args).toContain("exec");
      expect(args).toContain("--json");
    });

    it("includes -m flag when model is provided", () => {
      const args = codexAdapter.buildArgs({ prompt: "hello", workdir: "/tmp", model: "gpt-4o" });
      expect(args).toContain("-m");
      expect(args).toContain("gpt-4o");
    });

    it("does not include -m flag when model is absent", () => {
      const args = codexAdapter.buildArgs({ prompt: "hello", workdir: "/tmp" });
      expect(args).not.toContain("-m");
    });

    it("includes -c reasoning effort when reasoningLevel is provided", () => {
      const args = codexAdapter.buildArgs({ prompt: "hello", workdir: "/tmp", reasoningLevel: "high" });
      expect(args).toContain("-c");
      expect(args).toContain('model_reasoning_effort="high"');
    });

    it("does not include -c when reasoningLevel is absent", () => {
      const args = codexAdapter.buildArgs({ prompt: "hello", workdir: "/tmp" });
      expect(args).not.toContain("-c");
    });
  });

  describe("detectSubtask()", () => {
    it("returns subtask info for item.started with collab_tool_call spawn_agent", () => {
      const raw = JSON.stringify({
        type: "item.started",
        item: {
          type: "collab_tool_call",
          tool: "spawn_agent",
          id: "item_001",
          prompt: "Task: Build the login page\nDetails here",
        },
      });
      const result = codexAdapter.detectSubtask!(raw);
      expect(result).not.toBeNull();
      expect(result!.title).toBe("Build the login page");
    });

    it("strips 'Task: ' prefix from first line", () => {
      const raw = JSON.stringify({
        type: "item.started",
        item: {
          type: "collab_tool_call",
          tool: "spawn_agent",
          id: "item_002",
          prompt: "Task: Refactor auth module",
        },
      });
      const result = codexAdapter.detectSubtask!(raw);
      expect(result!.title).toBe("Refactor auth module");
    });

    it("returns null for non-spawn_agent item.started", () => {
      const raw = JSON.stringify({
        type: "item.started",
        item: { type: "collab_tool_call", tool: "something_else", id: "item_003" },
      });
      expect(codexAdapter.detectSubtask!(raw)).toBeNull();
    });

    it("returns null for non-JSON input", () => {
      expect(codexAdapter.detectSubtask!("plain text")).toBeNull();
    });
  });

  describe("parseStreamChunk()", () => {
    it("emits subtask_created for item.started spawn_agent", () => {
      const line = JSON.stringify({
        type: "item.started",
        item: {
          type: "collab_tool_call",
          tool: "spawn_agent",
          id: "item_001",
          prompt: "Do something important",
        },
      });
      const events = codexAdapter.parseStreamChunk(line + "\n");
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("subtask_created");
      expect(events[0].content).toBe("Do something important");
    });

    it("emits subtask_done for item.completed close_agent", () => {
      const line = JSON.stringify({
        type: "item.completed",
        item: {
          type: "collab_tool_call",
          tool: "close_agent",
          receiver_thread_ids: ["thread_abc"],
        },
      });
      const events = codexAdapter.parseStreamChunk(line + "\n");
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("subtask_done");
      expect(events[0].metadata?.threadId).toBe("thread_abc");
    });

    it("emits output for plain text lines", () => {
      const events = codexAdapter.parseStreamChunk("some output\n");
      expect(events[0].type).toBe("output");
      expect(events[0].content).toBe("some output");
    });
  });
});
