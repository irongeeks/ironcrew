import { describe, it, expect } from "vitest";
import { openclawAdapter } from "../../adapters/openclaw.ts";

describe("openclawAdapter", () => {
  it("has correct providerType, transport, and promptDelivery", () => {
    expect(openclawAdapter.providerType).toBe("openclaw");
    expect(openclawAdapter.transport).toBe("cli");
    expect(openclawAdapter.promptDelivery).toBe("flag");
    expect(openclawAdapter.promptFlag).toBe("--message");
  });

  describe("buildArgs()", () => {
    it("includes base flags: agent --local --json", () => {
      const args = openclawAdapter.buildArgs({ prompt: "hello", workdir: "/tmp" });
      expect(args).toContain("openclaw");
      expect(args).toContain("agent");
      expect(args).toContain("--local");
      expect(args).toContain("--json");
    });

    it("includes --profile flag when profile is provided", () => {
      const args = openclawAdapter.buildArgs({ prompt: "hello", workdir: "/tmp", profile: "qwen" });
      expect(args).toContain("--profile");
      expect(args).toContain("qwen");
    });

    it("does not include --profile flag when profile is absent", () => {
      const args = openclawAdapter.buildArgs({ prompt: "hello", workdir: "/tmp" });
      expect(args).not.toContain("--profile");
    });

    it("does not include --model flag even when model is provided (model set in profile config)", () => {
      const args = openclawAdapter.buildArgs({ prompt: "hello", workdir: "/tmp", model: "vllm/qwen3.5" });
      expect(args).not.toContain("--model");
      expect(args).not.toContain("-m");
      expect(args).not.toContain("vllm/qwen3.5");
    });

    it("places --profile before agent subcommand", () => {
      const args = openclawAdapter.buildArgs({ prompt: "hello", workdir: "/tmp", profile: "my-profile" });
      const profileIdx = args.indexOf("--profile");
      const agentIdx = args.indexOf("agent");
      expect(profileIdx).toBeLessThan(agentIdx);
    });
  });

  describe("parseStreamChunk()", () => {
    it("emits output for JSON lines with content field", () => {
      const line = JSON.stringify({ type: "message", content: "Agent is working..." });
      const events = openclawAdapter.parseStreamChunk(line + "\n");
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("output");
      expect(events[0].content).toBe("Agent is working...");
    });

    it("emits output for JSON lines with text field", () => {
      const line = JSON.stringify({ type: "chunk", text: "Processing request" });
      const events = openclawAdapter.parseStreamChunk(line + "\n");
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("output");
      expect(events[0].content).toBe("Processing request");
    });

    it("emits output for plain text lines", () => {
      const events = openclawAdapter.parseStreamChunk("plain text output\n");
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("output");
      expect(events[0].content).toBe("plain text output");
    });

    it("skips empty lines", () => {
      const events = openclawAdapter.parseStreamChunk("\n\n");
      expect(events).toHaveLength(0);
    });

    it("skips JSON lines with no recognizable content field", () => {
      const line = JSON.stringify({ type: "ping" });
      const events = openclawAdapter.parseStreamChunk(line + "\n");
      expect(events).toHaveLength(0);
    });

    it("emits token_usage event for result message with usage data", () => {
      const line = JSON.stringify({
        type: "result",
        usage: {
          input_tokens: 1000,
          output_tokens: 500,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 25,
        },
        model: "claude-sonnet-4-5",
      });
      const events = openclawAdapter.parseStreamChunk(line + "\n");
      const tokenEvent = events.find((e) => e.type === "token_usage");
      expect(tokenEvent).toBeDefined();
      expect(tokenEvent!.metadata).toEqual({
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_tokens: 100,
        cache_write_tokens: 25,
        model: "claude-sonnet-4-5",
      });
    });

    it("does not emit token_usage for result without usage", () => {
      const line = JSON.stringify({ type: "result", result: "done" });
      const events = openclawAdapter.parseStreamChunk(line + "\n");
      expect(events.find((e) => e.type === "token_usage")).toBeUndefined();
    });
  });

  it("supports token tracking", () => {
    expect(openclawAdapter.supportsTokenTracking).toBe(true);
  });
});
