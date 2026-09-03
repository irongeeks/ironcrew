import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests for encryptSecret / decryptSecret in server/oauth/helpers.ts
 *
 * Notes:
 * - The module captures OAUTH_ENCRYPTION_SECRET at import time (top-level const).
 *   To test behavior under different secret values we use vi.resetModules() and
 *   dynamic import() so each scenario gets a fresh module evaluation.
 */

const ORIG_OAUTH = process.env.OAUTH_ENCRYPTION_SECRET;
const ORIG_SESSION = process.env.SESSION_SECRET;

function restoreEnv() {
  if (ORIG_OAUTH === undefined) delete process.env.OAUTH_ENCRYPTION_SECRET;
  else process.env.OAUTH_ENCRYPTION_SECRET = ORIG_OAUTH;
  if (ORIG_SESSION === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = ORIG_SESSION;
}

async function loadHelpers(secret: string | null) {
  vi.resetModules();
  // Stub the runtime config module so its top-level `.env` loader does NOT run
  // during the dynamic import below. Without this stub, runtime.ts reads the
  // repository's `.env` from disk and re-populates OAUTH_ENCRYPTION_SECRET
  // whenever a developer has a local .env, which makes the "missing secret"
  // tests environment-dependent (X-002 review). helpers.ts only consumes
  // OAUTH_BASE_HOST and PORT from runtime.ts, so providing inert defaults
  // is sufficient for these tests.
  vi.doMock("../../config/runtime.ts", () => ({
    OAUTH_BASE_HOST: "localhost",
    PORT: 8790,
    SERVER_DIRNAME: "",
    PKG_VERSION: "0.0.0-test",
  }));
  if (secret === null) {
    delete process.env.OAUTH_ENCRYPTION_SECRET;
  } else {
    process.env.OAUTH_ENCRYPTION_SECRET = secret;
  }
  delete process.env.SESSION_SECRET;
  return await import("../../oauth/helpers.ts");
}

const SECRET_A = "a".repeat(32);
const SECRET_B = "b".repeat(32);

describe("encryptSecret / decryptSecret", () => {
  beforeEach(() => {
    delete process.env.OAUTH_ENCRYPTION_SECRET;
    delete process.env.SESSION_SECRET;
  });

  afterEach(() => {
    restoreEnv();
    vi.doUnmock("../../config/runtime.ts");
    vi.resetModules();
  });

  describe("round-trip", () => {
    it("encrypts then decrypts back to the original plaintext", async () => {
      const { encryptSecret, decryptSecret } = await loadHelpers(SECRET_A);
      const plaintext = "hello-world-token-abc123";
      const ciphertext = encryptSecret(plaintext);
      expect(ciphertext).not.toBe(plaintext);
      expect(decryptSecret(ciphertext)).toBe(plaintext);
    });

    it("round-trips an empty string", async () => {
      const { encryptSecret, decryptSecret } = await loadHelpers(SECRET_A);
      const ciphertext = encryptSecret("");
      expect(ciphertext.startsWith("v1:")).toBe(true);
      expect(decryptSecret(ciphertext)).toBe("");
    });

    it("round-trips a single-character string", async () => {
      const { encryptSecret, decryptSecret } = await loadHelpers(SECRET_A);
      expect(decryptSecret(encryptSecret("x"))).toBe("x");
    });

    it("round-trips unicode (multi-byte UTF-8) characters", async () => {
      const { encryptSecret, decryptSecret } = await loadHelpers(SECRET_A);
      const plaintext = "héllo-世界-🚀-Ωmega-Привет";
      const ciphertext = encryptSecret(plaintext);
      expect(decryptSecret(ciphertext)).toBe(plaintext);
    });

    it("round-trips a very long input (100 KB)", async () => {
      const { encryptSecret, decryptSecret } = await loadHelpers(SECRET_A);
      const plaintext = "x".repeat(100_000);
      const ciphertext = encryptSecret(plaintext);
      expect(decryptSecret(ciphertext)).toBe(plaintext);
    });

    it("handles realistic OAuth-style tokens", async () => {
      const { encryptSecret, decryptSecret } = await loadHelpers(SECRET_A);
      const tokens = [
        "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
        "ya29.A0AfH6SMC-some_long_google_access_token_with_chars-_=",
        "sk-proj-1234567890abcdefABCDEF",
      ];
      for (const t of tokens) {
        expect(decryptSecret(encryptSecret(t))).toBe(t);
      }
    });
  });

  describe("wire format", () => {
    it("emits the v1 format: 'v1:<iv-b64>:<tag-b64>:<ct-b64>'", async () => {
      const { encryptSecret } = await loadHelpers(SECRET_A);
      const ciphertext = encryptSecret("payload");
      const parts = ciphertext.split(":");
      expect(parts).toHaveLength(4);
      expect(parts[0]).toBe("v1");
      // IV = 12 bytes
      expect(Buffer.from(parts[1], "base64")).toHaveLength(12);
      // GCM tag = 16 bytes
      expect(Buffer.from(parts[2], "base64")).toHaveLength(16);
      // ciphertext non-empty for non-empty input
      expect(Buffer.from(parts[3], "base64").length).toBeGreaterThan(0);
    });

    it("uses a fresh random IV per call (different ciphertexts for same input)", async () => {
      const { encryptSecret } = await loadHelpers(SECRET_A);
      const a = encryptSecret("same-input");
      const b = encryptSecret("same-input");
      expect(a).not.toBe(b);
      // Specifically the IV component should differ
      expect(a.split(":")[1]).not.toBe(b.split(":")[1]);
    });

    it("decrypts a payload produced in a previous module load (stable v1 format across re-imports)", async () => {
      const first = await loadHelpers(SECRET_A);
      const ciphertext = first.encryptSecret("persisted-token");
      // simulate process restart with same secret
      const second = await loadHelpers(SECRET_A);
      expect(second.decryptSecret(ciphertext)).toBe("persisted-token");
    });
  });

  describe("failure modes", () => {
    it("throws when decrypting with the wrong OAUTH_ENCRYPTION_SECRET", async () => {
      const a = await loadHelpers(SECRET_A);
      const ciphertext = a.encryptSecret("top-secret");
      const b = await loadHelpers(SECRET_B);
      expect(() => b.decryptSecret(ciphertext)).toThrow();
    });

    it.each([
      ["empty string", ""],
      ["completely malformed", "not-an-encrypted-payload"],
      ["wrong version prefix", "v0:aaaa:bbbb:cccc"],
      ["missing fields", "v1:onlyone"],
      ["only three fields", "v1:aa:bb"],
      ["empty IV", "v1::tag:ct"],
      ["empty tag", "v1:iv::ct"],
    ])("throws invalid_encrypted_payload on %s", async (_label, input) => {
      const { decryptSecret } = await loadHelpers(SECRET_A);
      expect(() => decryptSecret(input)).toThrow(/invalid_encrypted_payload/);
    });

    it("throws (cleanly, no panic) on structurally-valid but tampered auth tag", async () => {
      const { encryptSecret, decryptSecret } = await loadHelpers(SECRET_A);
      const ciphertext = encryptSecret("original");
      const parts = ciphertext.split(":");
      const tag = Buffer.from(parts[2], "base64");
      tag[0] ^= 0xff;
      const tampered = ["v1", parts[1], tag.toString("base64"), parts[3]].join(":");
      expect(() => decryptSecret(tampered)).toThrow();
    });

    it("throws (cleanly) on tampered ciphertext body", async () => {
      const { encryptSecret, decryptSecret } = await loadHelpers(SECRET_A);
      const ciphertext = encryptSecret("original");
      const parts = ciphertext.split(":");
      const ct = Buffer.from(parts[3], "base64");
      if (ct.length > 0) ct[0] ^= 0xff;
      const tampered = ["v1", parts[1], parts[2], ct.toString("base64")].join(":");
      expect(() => decryptSecret(tampered)).toThrow();
    });

    it("encryptSecret throws when OAUTH_ENCRYPTION_SECRET is missing", async () => {
      const { encryptSecret } = await loadHelpers(null);
      expect(() => encryptSecret("anything")).toThrow(/OAUTH_ENCRYPTION_SECRET/);
    });

    it("encryptSecret throws when OAUTH_ENCRYPTION_SECRET is the placeholder __CHANGE_ME__", async () => {
      const { encryptSecret } = await loadHelpers("__CHANGE_ME__");
      expect(() => encryptSecret("anything")).toThrow(/OAUTH_ENCRYPTION_SECRET/);
    });

    it("decryptSecret throws when OAUTH_ENCRYPTION_SECRET is missing", async () => {
      const { decryptSecret } = await loadHelpers(null);
      // Structurally-valid v1 payload so we exercise the key-derivation guard,
      // not the format check.
      const fakeIv = Buffer.alloc(12).toString("base64");
      const fakeTag = Buffer.alloc(16).toString("base64");
      const fakeCt = Buffer.from("xx").toString("base64");
      expect(() => decryptSecret(`v1:${fakeIv}:${fakeTag}:${fakeCt}`)).toThrow(/OAUTH_ENCRYPTION_SECRET/);
    });
  });
});
