/**
 * The `agy` adapter.
 *
 * Flags are asserted verbatim against the published headless-mode
 * documentation, because a flag that does not exist fails at spawn time on
 * the operator's machine and nowhere earlier.
 */

import { describe, it, expect } from "vitest";
import { antigravityAdapter } from "../../adapters/antigravity.ts";
import { assertArgsMatchMode, PermissionPolicyError } from "../../ironcrew/policy/runtime-permissions.ts";

describe("antigravityAdapter", () => {
  it("is a CLI adapter for the agy binary", () => {
    expect(antigravityAdapter.providerType).toBe("antigravity");
    expect(antigravityAdapter.transport).toBe("cli");
    expect(antigravityAdapter.buildArgs({ prompt: "x", workdir: "/tmp" })[0]).toBe("agy");
  });

  it("takes its prompt by flag, because -p ignores stdin", () => {
    expect(antigravityAdapter.promptDelivery).toBe("flag");
    expect(antigravityAdapter.promptFlag).toBe("-p");
  });

  it("names no session flag — agy has none", () => {
    expect(antigravityAdapter.sessionFlag).toBeUndefined();
  });

  describe("buildArgs()", () => {
    it("asks for the streaming NDJSON format", () => {
      const args = antigravityAdapter.buildArgs({ prompt: "x", workdir: "/tmp" });
      expect(args).toContain("--output-format");
      expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
    });

    it("passes model and effort through when given", () => {
      const args = antigravityAdapter.buildArgs({
        prompt: "x",
        workdir: "/tmp",
        model: "gemini-3-pro",
        reasoningLevel: "high",
      });
      expect(args[args.indexOf("--model") + 1]).toBe("gemini-3-pro");
      expect(args[args.indexOf("--effort") + 1]).toBe("high");
    });

    it("sandboxes by default and never skips permissions without an elevation", () => {
      for (const mode of ["restricted", "workspace_write"] as const) {
        const args = antigravityAdapter.buildArgs({ prompt: "x", workdir: "/tmp", permissionMode: mode });
        expect(args).toContain("--sandbox");
        expect(args).not.toContain("--dangerously-skip-permissions");
        // The guard that runs immediately before spawn must accept these.
        expect(() => assertArgsMatchMode(args, mode)).not.toThrow();
      }
    });

    it("skips permissions only when policy resolved to elevated", () => {
      const args = antigravityAdapter.buildArgs({ prompt: "x", workdir: "/tmp", permissionMode: "elevated" });
      expect(args).toContain("--dangerously-skip-permissions");
      expect(() => assertArgsMatchMode(args, "elevated")).not.toThrow();
      // And the same argv is refused for any lesser mode.
      expect(() => assertArgsMatchMode(args, "restricted")).toThrow(PermissionPolicyError);
    });

    it("treats a missing permission mode as restricted, never as elevated", () => {
      const args = antigravityAdapter.buildArgs({ prompt: "x", workdir: "/tmp" });
      expect(args).not.toContain("--dangerously-skip-permissions");
      expect(args).toContain("--sandbox");
    });
  });

  describe("parseStreamChunk()", () => {
    it("returns the agent's answer from the result event", () => {
      const line = JSON.stringify({
        event: "result",
        result: { conversation_id: "c1", status: "SUCCESS", response: "Fertig.", duration_seconds: 7.16 },
      });
      const events = antigravityAdapter.parseStreamChunk(line);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("output");
      expect(events[0].content).toBe("Fertig.");
      expect(events[0].metadata?.conversationId).toBe("c1");
    });

    it("reports a non-SUCCESS result as an error, not as output", () => {
      const line = JSON.stringify({ event: "result", result: { status: "FAILED", response: "Kein Modell." } });
      const [event] = antigravityAdapter.parseStreamChunk(line);
      expect(event.type).toBe("error");
      expect(event.content).toBe("Kein Modell.");
    });

    it("names the status when a failed result carries no message", () => {
      const line = JSON.stringify({ event: "result", result: { status: "CANCELLED" } });
      const [event] = antigravityAdapter.parseStreamChunk(line);
      expect(event.type).toBe("error");
      expect(event.content).toContain("CANCELLED");
    });

    it("surfaces a finished step as tool use", () => {
      const line = JSON.stringify({
        event: "step_update",
        step_update: { conversation_id: "c1", step_index: 2, state: "DONE", step_type: "run_command" },
      });
      const [event] = antigravityAdapter.parseStreamChunk(line);
      expect(event.type).toBe("tool_use");
      expect(event.content).toBe("run_command");
      expect(event.metadata?.stepIndex).toBe(2);
    });

    it("ignores steps that are not finished, so one step is not logged three times", () => {
      const line = JSON.stringify({
        event: "step_update",
        step_update: { step_index: 0, state: "RUNNING", step_type: "run_command" },
      });
      expect(antigravityAdapter.parseStreamChunk(line)).toEqual([]);
    });

    it("ignores the echo of the operator's own prompt", () => {
      const line = JSON.stringify({
        event: "step_update",
        step_update: { step_index: 0, state: "DONE", step_type: "user_input" },
      });
      expect(antigravityAdapter.parseStreamChunk(line)).toEqual([]);
    });

    it("ignores the init event", () => {
      const line = JSON.stringify({ event: "init", conversation_id: "c1", init: { cwd: "/tmp", tools: [] } });
      expect(antigravityAdapter.parseStreamChunk(line)).toEqual([]);
    });

    it("keeps non-JSON output rather than dropping it — that is where the failure is", () => {
      const events = antigravityAdapter.parseStreamChunk("agy: command failed: no credentials\n");
      expect(events).toEqual([{ type: "output", content: "agy: command failed: no credentials" }]);
    });

    it("handles several events in one chunk", () => {
      const chunk = [
        JSON.stringify({ event: "init", conversation_id: "c1" }),
        JSON.stringify({ event: "step_update", step_update: { state: "DONE", step_type: "edit_file" } }),
        JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "ok" } }),
        "",
      ].join("\n");
      expect(antigravityAdapter.parseStreamChunk(chunk).map((e) => e.type)).toEqual(["tool_use", "output"]);
    });
  });

  describe("testEnvironment()", () => {
    it("reports rather than throws when agy is not installed", async () => {
      const result = await antigravityAdapter.testEnvironment();
      expect(typeof result.ok).toBe("boolean");
      if (!result.ok) expect(result.message).toContain("agy");
    });
  });
});
