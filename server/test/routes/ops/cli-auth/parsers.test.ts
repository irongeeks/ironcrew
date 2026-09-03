import { describe, it, expect } from "vitest";
import {
  parseClaudeOutput,
  parseCodexOutput,
  parseGeminiOutput,
  parseProviderOutput,
} from "../../../../modules/routes/ops/cli-auth/parsers.ts";

describe("parseClaudeOutput", () => {
  it("extracts OAuth URL from claude auth login stdout", () => {
    const stdout =
      "Opening browser to sign in…\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key&code_challenge=X_toWY5f&code_challenge_method=S256&state=pwjSFn70";
    const result = parseClaudeOutput(stdout);
    expect(result.verificationUrl).toMatch(/^https:\/\/claude\.com\/cai\/oauth\/authorize\?/);
    expect(result.deviceCode).toBeNull();
  });

  it("returns nulls when stdout has no URL", () => {
    const result = parseClaudeOutput("Some unexpected output");
    expect(result.verificationUrl).toBeNull();
    expect(result.deviceCode).toBeNull();
  });

  it("strips trailing punctuation from URL", () => {
    const stdout = "visit: https://claude.com/cai/oauth/authorize?state=abc.";
    const result = parseClaudeOutput(stdout);
    expect(result.verificationUrl).toBe("https://claude.com/cai/oauth/authorize?state=abc");
  });
});

describe("parseCodexOutput", () => {
  it("extracts device code and verification URL", () => {
    const stdout = "Enter this code: ABCD-1234\nVisit: https://auth.openai.com/device\nWaiting for authentication...";
    const result = parseCodexOutput(stdout);
    expect(result.verificationUrl).toBe("https://auth.openai.com/device");
    expect(result.deviceCode).toBe("ABCD-1234");
  });

  it("extracts URL-only output (no device code)", () => {
    const stdout = "Opening browser to: https://auth.openai.com/authorize?client_id=abc";
    const result = parseCodexOutput(stdout);
    expect(result.verificationUrl).toMatch(/^https:\/\/auth\.openai\.com/);
    expect(result.deviceCode).toBeNull();
  });

  it("returns nulls for empty output", () => {
    const result = parseCodexOutput("");
    expect(result.verificationUrl).toBeNull();
    expect(result.deviceCode).toBeNull();
  });
});

describe("parseGeminiOutput", () => {
  it("extracts Google OAuth URL", () => {
    const stdout =
      "To authenticate, visit:\nhttps://accounts.google.com/o/oauth2/v2/auth?client_id=abc&scope=email&response_type=code";
    const result = parseGeminiOutput(stdout);
    expect(result.verificationUrl).toMatch(/^https:\/\/accounts\.google\.com/);
    expect(result.deviceCode).toBeNull();
  });

  it("returns nulls for unrecognized output", () => {
    const result = parseGeminiOutput("Error: network unavailable");
    expect(result.verificationUrl).toBeNull();
    expect(result.deviceCode).toBeNull();
  });
});

describe("parseProviderOutput", () => {
  it("dispatches to the correct parser", () => {
    const stdout = "visit: https://claude.com/cai/oauth/authorize?state=test";
    const result = parseProviderOutput("claude", stdout);
    expect(result.verificationUrl).toMatch(/^https:\/\/claude\.com/);
  });

  it("returns nulls for unknown provider", () => {
    const result = parseProviderOutput("unknown", "anything");
    expect(result.verificationUrl).toBeNull();
    expect(result.deviceCode).toBeNull();
  });
});
