import { describe, it, expect, vi } from "vitest";

vi.mock("../oauth/helpers.ts", () => ({
  encryptSecret: (s: string) => "ENCRYPTED:" + s,
  decryptSecret: (s: string) => {
    if (s.startsWith("ENCRYPTED:")) return s.slice(10);
    throw new Error("decrypt_failed");
  },
}));

import {
  encryptMessengerChannelsForStorage,
  decryptMessengerChannelsForClient,
  decryptMessengerChannelsForRuntime,
  decryptMessengerTokenForRuntime,
} from "./token-crypto.ts";

const PREFIX = "__ce_enc_v1__:";

describe("encryptMessengerChannelsForStorage", () => {
  it("returns non-record input unchanged", () => {
    expect(encryptMessengerChannelsForStorage(null)).toBe(null);
    expect(encryptMessengerChannelsForStorage("hello")).toBe("hello");
    expect(encryptMessengerChannelsForStorage(42)).toBe(42);
    expect(encryptMessengerChannelsForStorage([1, 2])).toEqual([1, 2]);
  });

  it("encrypts channel-level token", () => {
    const input = { telegram: { token: "tg-secret-123" } };
    const result = encryptMessengerChannelsForStorage(input) as any;
    expect(result.telegram.token).toBe(`${PREFIX}ENCRYPTED:tg-secret-123`);
  });

  it("encrypts session-level tokens", () => {
    const input = {
      discord: {
        sessions: [
          { id: "s1", token: "disc-token-a" },
          { id: "s2", token: "disc-token-b" },
        ],
      },
    };
    const result = encryptMessengerChannelsForStorage(input) as any;
    expect(result.discord.sessions[0].token).toBe(`${PREFIX}ENCRYPTED:disc-token-a`);
    expect(result.discord.sessions[1].token).toBe(`${PREFIX}ENCRYPTED:disc-token-b`);
  });

  it("skips already-encrypted tokens", () => {
    const encrypted = `${PREFIX}ENCRYPTED:already-done`;
    const input = { telegram: { token: encrypted } };
    const result = encryptMessengerChannelsForStorage(input) as any;
    expect(result.telegram.token).toBe(encrypted);
  });

  it("returns empty string for empty/whitespace token", () => {
    const input = { telegram: { token: "  " } };
    const result = encryptMessengerChannelsForStorage(input) as any;
    expect(result.telegram.token).toBe("");
  });

  it("preserves channels without token field", () => {
    const input = { telegram: { receiveEnabled: true } };
    const result = encryptMessengerChannelsForStorage(input) as any;
    expect(result.telegram).toEqual({ receiveEnabled: true });
  });

  it("preserves non-messenger channel keys", () => {
    const input = { telegram: { token: "abc" }, customKey: { foo: "bar" } };
    const result = encryptMessengerChannelsForStorage(input) as any;
    expect(result.customKey).toEqual({ foo: "bar" });
  });

  it("skips sessions without token field", () => {
    const input = {
      telegram: {
        sessions: [{ id: "s1", targetId: "123" }],
      },
    };
    const result = encryptMessengerChannelsForStorage(input) as any;
    expect(result.telegram.sessions[0]).toEqual({ id: "s1", targetId: "123" });
  });

  it("skips non-record sessions", () => {
    const input = {
      telegram: {
        sessions: ["not-a-record", 42, null],
      },
    };
    const result = encryptMessengerChannelsForStorage(input) as any;
    expect(result.telegram.sessions).toEqual(["not-a-record", 42, null]);
  });
});

describe("decryptMessengerChannelsForClient", () => {
  it("decrypts channel-level token", () => {
    const input = { telegram: { token: `${PREFIX}ENCRYPTED:my-token` } };
    const result = decryptMessengerChannelsForClient(input) as any;
    expect(result.telegram.token).toBe("my-token");
  });

  it("decrypts session-level tokens", () => {
    const input = {
      discord: {
        sessions: [{ id: "s1", token: `${PREFIX}ENCRYPTED:disc-tok` }],
      },
    };
    const result = decryptMessengerChannelsForClient(input) as any;
    expect(result.discord.sessions[0].token).toBe("disc-tok");
  });

  it("returns original on decrypt failure (raw mode)", () => {
    const badToken = `${PREFIX}NOT_VALID_ENCRYPTED_DATA`;
    const input = { telegram: { token: badToken } };
    const result = decryptMessengerChannelsForClient(input) as any;
    expect(result.telegram.token).toBe(badToken);
  });

  it("returns plaintext token as-is (no prefix)", () => {
    const input = { telegram: { token: "plaintext-token" } };
    const result = decryptMessengerChannelsForClient(input) as any;
    expect(result.telegram.token).toBe("plaintext-token");
  });
});

describe("decryptMessengerChannelsForRuntime", () => {
  it("decrypts channel-level token", () => {
    const input = { telegram: { token: `${PREFIX}ENCRYPTED:my-token` } };
    const result = decryptMessengerChannelsForRuntime(input) as any;
    expect(result.telegram.token).toBe("my-token");
  });

  it("returns empty string on decrypt failure (empty mode)", () => {
    const badToken = `${PREFIX}NOT_VALID_ENCRYPTED_DATA`;
    const input = { telegram: { token: badToken } };
    const result = decryptMessengerChannelsForRuntime(input) as any;
    expect(result.telegram.token).toBe("");
  });

  it("returns empty string for prefix-only token (empty mode)", () => {
    const input = { telegram: { token: `${PREFIX}  ` } };
    const result = decryptMessengerChannelsForRuntime(input) as any;
    expect(result.telegram.token).toBe("");
  });
});

describe("decryptMessengerTokenForRuntime", () => {
  it("decrypts a valid encrypted token", () => {
    const result = decryptMessengerTokenForRuntime("telegram", `${PREFIX}ENCRYPTED:tg-tok`);
    expect(result).toBe("tg-tok");
  });

  it("returns empty string on failure", () => {
    const result = decryptMessengerTokenForRuntime("telegram", `${PREFIX}GARBAGE`);
    expect(result).toBe("");
  });

  it("returns plaintext as-is", () => {
    const result = decryptMessengerTokenForRuntime("discord", "plain-token");
    expect(result).toBe("plain-token");
  });

  it("returns empty string for empty input", () => {
    const result = decryptMessengerTokenForRuntime("telegram", "");
    expect(result).toBe("");
  });

  it("returns empty string for non-string input", () => {
    const result = decryptMessengerTokenForRuntime("telegram", undefined);
    expect(result).toBe("");
  });
});

describe("encrypt → decrypt roundtrip", () => {
  it("client decrypt recovers original after encrypt", () => {
    const input = {
      telegram: { token: "my-secret" },
      discord: { sessions: [{ id: "s1", token: "disc-secret" }] },
    };
    const encrypted = encryptMessengerChannelsForStorage(input);
    const decrypted = decryptMessengerChannelsForClient(encrypted) as any;
    expect(decrypted.telegram.token).toBe("my-secret");
    expect(decrypted.discord.sessions[0].token).toBe("disc-secret");
  });

  it("runtime decrypt recovers original after encrypt", () => {
    const input = { telegram: { token: "rt-secret" } };
    const encrypted = encryptMessengerChannelsForStorage(input);
    const decrypted = decryptMessengerChannelsForRuntime(encrypted) as any;
    expect(decrypted.telegram.token).toBe("rt-secret");
  });
});
