import { describe, it, expect } from "vitest";
import { geminiAdapter } from "../../adapters/gemini.ts";

describe("geminiAdapter", () => {
  it("has correct providerType, transport, and promptDelivery", () => {
    expect(geminiAdapter.providerType).toBe("gemini");
    expect(geminiAdapter.transport).toBe("cli");
    expect(geminiAdapter.promptDelivery).toBe("stdin");
  });

  describe("buildArgs()", () => {
    it("includes base flags: approval-mode default --output-format=stream-json", () => {
      const args = geminiAdapter.buildArgs({ prompt: "hello", workdir: "/tmp" });
      expect(args).toContain("gemini");
      // Iron Command: --yolo is no longer a base flag.
      expect(args).not.toContain("--yolo");
      expect(args).toContain("--approval-mode");
      expect(args).toContain("default");
      expect(args).toContain("--output-format=stream-json");
    });

    it("includes -m flag when model is provided", () => {
      const args = geminiAdapter.buildArgs({ prompt: "hello", workdir: "/tmp", model: "gemini-2.0-flash" });
      expect(args).toContain("-m");
      expect(args).toContain("gemini-2.0-flash");
    });

    it("does not include -m flag when model is absent", () => {
      const args = geminiAdapter.buildArgs({ prompt: "hello", workdir: "/tmp" });
      expect(args).not.toContain("-m");
    });
  });

  describe("detectSubtask()", () => {
    it("returns first subtask from subtasks JSON in message content", () => {
      const subtasksJson = JSON.stringify({ subtasks: [{ title: "Research APIs" }, { title: "Write tests" }] });
      const raw = JSON.stringify({
        type: "message",
        content: `Here is my plan:\n${subtasksJson}`,
      });
      const result = geminiAdapter.detectSubtask!(raw);
      expect(result).not.toBeNull();
      expect(result!.title).toBe("Research APIs");
    });

    it("returns null when message has no subtasks JSON", () => {
      const raw = JSON.stringify({ type: "message", content: "Just a regular message" });
      expect(geminiAdapter.detectSubtask!(raw)).toBeNull();
    });

    it("returns null for non-message types", () => {
      const raw = JSON.stringify({ type: "output", content: "something" });
      expect(geminiAdapter.detectSubtask!(raw)).toBeNull();
    });

    it("returns null for non-JSON input", () => {
      expect(geminiAdapter.detectSubtask!("plain text")).toBeNull();
    });
  });

  describe("detectSubtaskDone()", () => {
    it("returns title as id for subtask_done JSON in message content", () => {
      const raw = JSON.stringify({
        type: "message",
        content: 'Completed: {"subtask_done": "Research APIs"}',
      });
      const result = geminiAdapter.detectSubtaskDone!(raw);
      expect(result).not.toBeNull();
      expect(result!.id).toBe("Research APIs");
    });

    it("returns null when no subtask_done in content", () => {
      const raw = JSON.stringify({ type: "message", content: "Nothing special" });
      expect(geminiAdapter.detectSubtaskDone!(raw)).toBeNull();
    });
  });

  describe("parseStreamChunk()", () => {
    it("emits subtask_created events for all subtasks in plan", () => {
      const subtasksJson = JSON.stringify({ subtasks: [{ title: "Task A" }, { title: "Task B" }] });
      const line = JSON.stringify({ type: "message", content: subtasksJson });
      const events = geminiAdapter.parseStreamChunk(line + "\n");
      const created = events.filter((e) => e.type === "subtask_created");
      expect(created).toHaveLength(2);
      expect(created[0].content).toBe("Task A");
      expect(created[1].content).toBe("Task B");
    });

    it("emits subtask_done for subtask_done JSON in message", () => {
      const line = JSON.stringify({ type: "message", content: '{"subtask_done": "Task A"}' });
      const events = geminiAdapter.parseStreamChunk(line + "\n");
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("subtask_done");
      expect(events[0].metadata?.title).toBe("Task A");
    });

    it("emits output for regular message content", () => {
      const line = JSON.stringify({ type: "message", content: "Working on it..." });
      const events = geminiAdapter.parseStreamChunk(line + "\n");
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("output");
      expect(events[0].content).toBe("Working on it...");
    });

    it("emits output for plain text lines", () => {
      const events = geminiAdapter.parseStreamChunk("plain text\n");
      expect(events[0].type).toBe("output");
      expect(events[0].content).toBe("plain text");
    });
  });
});
