import { describe, it, expect, vi } from "vitest";
import { createUsageCliTools } from "../../../../modules/workflow/agents/providers/usage-cli-tools.ts";

describe("checkTokenFreshness", () => {
  function buildTools(overrides: Partial<Parameters<typeof createUsageCliTools>[0]> = {}) {
    return createUsageCliTools({
      jsonHasKey: vi.fn().mockReturnValue(false),
      fileExistsNonEmpty: vi.fn().mockReturnValue(false),
      readClaudeToken: vi.fn().mockReturnValue(null),
      readCodexTokens: vi.fn().mockReturnValue(null),
      readGeminiCredsFromKeychain: vi.fn().mockReturnValue(null),
      freshGeminiToken: vi.fn().mockResolvedValue(null),
      getGeminiProjectId: vi.fn().mockResolvedValue(null),
      ...overrides,
    });
  }

  it("returns 'unknown' for unrecognized provider", () => {
    const tools = buildTools();
    expect(tools.checkTokenFreshness("unknown")).toBe("unknown");
  });

  it("returns 'expired' when claude token is not found", () => {
    const tools = buildTools({ readClaudeToken: vi.fn().mockReturnValue(null) });
    expect(tools.checkTokenFreshness("claude")).toBe("expired");
  });

  it("returns 'valid' when claude token exists", () => {
    const tools = buildTools({ readClaudeToken: vi.fn().mockReturnValue("some-token") });
    expect(tools.checkTokenFreshness("claude")).toBe("valid");
  });

  it("returns 'expired' when codex tokens not found", () => {
    const tools = buildTools({ readCodexTokens: vi.fn().mockReturnValue(null) });
    expect(tools.checkTokenFreshness("codex")).toBe("expired");
  });

  it("returns 'valid' when codex tokens exist", () => {
    const tools = buildTools({
      readCodexTokens: vi.fn().mockReturnValue({ access_token: "tok", account_id: "acc" }),
    });
    expect(tools.checkTokenFreshness("codex")).toBe("valid");
  });
});
