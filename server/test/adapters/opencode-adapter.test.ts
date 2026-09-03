import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promisify } from "node:util";

// Mock node:child_process so testEnvironment never spawns a real binary.
// promisify(execFile) is special — Node attaches util.promisify.custom on execFile so
// the awaited result is { stdout, stderr }. We replicate that contract here.
const execFileMock = vi.fn<(file: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>>();
vi.mock("node:child_process", () => {
  const fn: ((...a: unknown[]) => unknown) & { [k: symbol]: unknown } = ((..._args: unknown[]) => {
    throw new Error("callback-style execFile not used in this test");
  }) as never;
  fn[promisify.custom] = (file: string, args: readonly string[]) => execFileMock(file, args);
  return { execFile: fn };
});

// Import AFTER mock so the adapter's promisified execFile binds to the mock.
import { opencodeAdapter } from "../../adapters/opencode.ts";

describe("opencodeAdapter", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("has correct providerType, transport, promptDelivery, and metadata", () => {
    expect(opencodeAdapter.name).toBe("OpenCode");
    expect(opencodeAdapter.providerType).toBe("opencode");
    expect(opencodeAdapter.transport).toBe("cli");
    expect(opencodeAdapter.promptDelivery).toBe("stdin");
    expect(opencodeAdapter.supportsTokenTracking).toBe(false);
  });

  describe("buildArgs()", () => {
    it("returns base args: opencode run --format json", () => {
      const args = opencodeAdapter.buildArgs({ prompt: "hello", workdir: "/tmp" });
      expect(args[0]).toBe("opencode");
      expect(args[1]).toBe("run");
      expect(args).toContain("--format");
      const idx = args.indexOf("--format");
      expect(args[idx + 1]).toBe("json");
    });

    it("does not include -m when model is absent", () => {
      const args = opencodeAdapter.buildArgs({ prompt: "hello", workdir: "/tmp" });
      expect(args).not.toContain("-m");
    });

    it("includes -m <model> when model is provided", () => {
      const args = opencodeAdapter.buildArgs({ prompt: "hello", workdir: "/tmp", model: "claude-3-5-sonnet" });
      const idx = args.indexOf("-m");
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe("claude-3-5-sonnet");
    });

    it("places -m flag before --format flag", () => {
      const args = opencodeAdapter.buildArgs({ prompt: "hello", workdir: "/tmp", model: "gpt-4o" });
      expect(args.indexOf("-m")).toBeLessThan(args.indexOf("--format"));
    });

    it("handles empty prompt without throwing (prompt comes via stdin, not args)", () => {
      const args = opencodeAdapter.buildArgs({ prompt: "", workdir: "/tmp" });
      expect(args).not.toContain("");
      expect(args[0]).toBe("opencode");
    });

    it("does not embed prompt content in CLI args", () => {
      const args = opencodeAdapter.buildArgs({
        prompt: "secret-payload --rm -rf /",
        workdir: "/tmp",
      });
      expect(args).not.toContain("secret-payload --rm -rf /");
    });

    it("preserves model strings with special characters", () => {
      const args = opencodeAdapter.buildArgs({ prompt: "x", workdir: "/tmp", model: "vendor/model:v1.2-beta" });
      const idx = args.indexOf("-m");
      expect(args[idx + 1]).toBe("vendor/model:v1.2-beta");
    });

    it("ignores unrelated context fields (profile, reasoningLevel, maxTurns)", () => {
      const args = opencodeAdapter.buildArgs({
        prompt: "x",
        workdir: "/tmp",
        profile: "any",
        reasoningLevel: "high",
        maxTurns: 5,
      });
      expect(args).not.toContain("--profile");
      expect(args).not.toContain("any");
      expect(args).not.toContain("--reasoning");
      expect(args).not.toContain("high");
    });

    it("returns a fresh array each call (no shared state)", () => {
      const a = opencodeAdapter.buildArgs({ prompt: "x", workdir: "/tmp" });
      const b = opencodeAdapter.buildArgs({ prompt: "x", workdir: "/tmp" });
      expect(a).not.toBe(b);
      expect(a).toEqual(b);
    });
  });

  describe("parseStreamChunk()", () => {
    it("emits output for JSON line with content field", () => {
      const events = opencodeAdapter.parseStreamChunk(JSON.stringify({ content: "hello world" }) + "\n");
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: "output", content: "hello world" });
    });

    it("emits output for JSON line with text field", () => {
      const events = opencodeAdapter.parseStreamChunk(JSON.stringify({ text: "streamed text" }) + "\n");
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("output");
      expect(events[0].content).toBe("streamed text");
    });

    it("emits output for JSON line with message field", () => {
      const events = opencodeAdapter.parseStreamChunk(JSON.stringify({ message: "msg field" }) + "\n");
      expect(events).toHaveLength(1);
      expect(events[0].content).toBe("msg field");
    });

    it("prefers content over text and message when multiple fields exist", () => {
      const events = opencodeAdapter.parseStreamChunk(JSON.stringify({ content: "C", text: "T", message: "M" }) + "\n");
      expect(events).toHaveLength(1);
      expect(events[0].content).toBe("C");
    });

    it("falls back to text when content is missing/empty", () => {
      const events = opencodeAdapter.parseStreamChunk(JSON.stringify({ content: "", text: "T" }) + "\n");
      expect(events[0].content).toBe("T");
    });

    it("falls back to message when content and text are missing/empty", () => {
      const events = opencodeAdapter.parseStreamChunk(JSON.stringify({ content: "", text: "", message: "M" }) + "\n");
      expect(events[0].content).toBe("M");
    });

    it("emits output for plain non-JSON text lines", () => {
      const events = opencodeAdapter.parseStreamChunk("plain text line\n");
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: "output", content: "plain text line" });
    });

    it("tolerates malformed JSON by treating the line as plain text", () => {
      const events = opencodeAdapter.parseStreamChunk("{invalid json}\n");
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("output");
      expect(events[0].content).toBe("{invalid json}");
    });

    it("skips empty lines (split + filter Boolean)", () => {
      const events = opencodeAdapter.parseStreamChunk("\n\n\n");
      expect(events).toHaveLength(0);
    });

    it("skips JSON lines with no recognizable content fields", () => {
      const events = opencodeAdapter.parseStreamChunk(JSON.stringify({ type: "ping" }) + "\n");
      expect(events).toHaveLength(0);
    });

    it("skips JSON lines where all content/text/message fields are falsy", () => {
      const events = opencodeAdapter.parseStreamChunk(
        JSON.stringify({ content: null, text: false, message: 0 }) + "\n",
      );
      expect(events).toHaveLength(0);
    });

    it("processes multiple lines in a single chunk", () => {
      const raw = [JSON.stringify({ content: "first" }), "plain second", JSON.stringify({ text: "third" }), ""].join(
        "\n",
      );
      const events = opencodeAdapter.parseStreamChunk(raw);
      expect(events).toHaveLength(3);
      expect(events[0].content).toBe("first");
      expect(events[1].content).toBe("plain second");
      expect(events[2].content).toBe("third");
    });

    it("ignores whitespace-only plain lines (line.trim() falsy)", () => {
      const events = opencodeAdapter.parseStreamChunk("   \n\t\n");
      expect(events).toHaveLength(0);
    });

    it("returns an empty array for an empty input string", () => {
      expect(opencodeAdapter.parseStreamChunk("")).toEqual([]);
    });
  });

  describe("testEnvironment()", () => {
    it("returns ok=true with trimmed version when CLI responds", async () => {
      execFileMock.mockResolvedValueOnce({ stdout: "opencode 1.2.3\n", stderr: "" });
      const result = await opencodeAdapter.testEnvironment();
      expect(result.ok).toBe(true);
      expect(result.version).toBe("opencode 1.2.3");
      expect(result.message).toContain("opencode CLI found");
      expect(execFileMock).toHaveBeenCalledWith("opencode", ["--version"]);
    });

    it("returns ok=false when binary is missing (ENOENT)", async () => {
      const err = Object.assign(new Error("spawn opencode ENOENT"), { code: "ENOENT" });
      execFileMock.mockRejectedValueOnce(err);
      const result = await opencodeAdapter.testEnvironment();
      expect(result.ok).toBe(false);
      expect(result.version).toBeUndefined();
      expect(result.message).toContain("not found in PATH");
    });

    it("returns ok=false when CLI exits with non-zero code", async () => {
      execFileMock.mockRejectedValueOnce(new Error("Command failed: exit 1"));
      const result = await opencodeAdapter.testEnvironment();
      expect(result.ok).toBe(false);
      expect(result.message).toContain("not found in PATH");
    });

    it("returns ok=false when execFile times out", async () => {
      const err = Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
      execFileMock.mockRejectedValueOnce(err);
      const result = await opencodeAdapter.testEnvironment();
      expect(result.ok).toBe(false);
    });

    it("does not throw even on unexpected error shape", async () => {
      execFileMock.mockRejectedValueOnce("string-shaped failure");
      await expect(opencodeAdapter.testEnvironment()).resolves.toEqual({
        ok: false,
        message: "opencode CLI not found in PATH",
      });
    });

    it("trims trailing whitespace and newlines from version output", async () => {
      execFileMock.mockResolvedValueOnce({ stdout: "  opencode 0.9.0  \n\n", stderr: "" });
      const result = await opencodeAdapter.testEnvironment();
      expect(result.version).toBe("opencode 0.9.0");
    });
  });
});
