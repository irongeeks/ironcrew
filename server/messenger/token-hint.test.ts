import { describe, it, expect } from "vitest";
import { buildMessengerTokenKey, buildMessengerSourceWithTokenHint } from "./token-hint.ts";

describe("buildMessengerTokenKey", () => {
  it("returns empty string for empty token", () => {
    expect(buildMessengerTokenKey("telegram", "")).toBe("");
  });

  it("returns empty string for non-string token", () => {
    expect(buildMessengerTokenKey("telegram", undefined)).toBe("");
    expect(buildMessengerTokenKey("telegram", null)).toBe("");
    expect(buildMessengerTokenKey("telegram", 42)).toBe("");
  });

  it("returns 16-character hex string for valid token", () => {
    const key = buildMessengerTokenKey("telegram", "bot123:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw");
    expect(key).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is deterministic — same input produces same output", () => {
    const key1 = buildMessengerTokenKey("telegram", "my-token");
    const key2 = buildMessengerTokenKey("telegram", "my-token");
    expect(key1).toBe(key2);
  });

  it("different channels produce different keys for same token", () => {
    const tgKey = buildMessengerTokenKey("telegram", "shared-token");
    const dcKey = buildMessengerTokenKey("discord", "shared-token");
    expect(tgKey).not.toBe(dcKey);
  });

  it("different tokens produce different keys for same channel", () => {
    const key1 = buildMessengerTokenKey("telegram", "token-aaa");
    const key2 = buildMessengerTokenKey("telegram", "token-bbb");
    expect(key1).not.toBe(key2);
  });
});

describe("buildMessengerSourceWithTokenHint", () => {
  it("returns just the channel name for empty key", () => {
    expect(buildMessengerSourceWithTokenHint("telegram", "")).toBe("telegram");
  });

  it("returns just the channel name for whitespace key", () => {
    expect(buildMessengerSourceWithTokenHint("discord", "   ")).toBe("discord");
  });

  it("returns channel#key format for valid key", () => {
    expect(buildMessengerSourceWithTokenHint("telegram", "abc123def456")).toBe("telegram#abc123def456");
  });

  it("lowercases the key", () => {
    expect(buildMessengerSourceWithTokenHint("telegram", "ABC123")).toBe("telegram#abc123");
  });
});
