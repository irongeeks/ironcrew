import { createHash } from "node:crypto";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  appendOAuthQuery,
  assertOAuthEncryptionReady,
  b64url,
  getEncryptionSecretStatus,
  pkceChallengeS256,
  pkceVerifier,
  sanitizeOAuthRedirect,
} from "../../oauth/helpers.ts";

describe("getEncryptionSecretStatus", () => {
  const originalOAuth = process.env.OAUTH_ENCRYPTION_SECRET;
  const originalSession = process.env.SESSION_SECRET;

  beforeEach(() => {
    delete process.env.OAUTH_ENCRYPTION_SECRET;
    delete process.env.SESSION_SECRET;
  });

  afterEach(() => {
    if (originalOAuth === undefined) delete process.env.OAUTH_ENCRYPTION_SECRET;
    else process.env.OAUTH_ENCRYPTION_SECRET = originalOAuth;
    if (originalSession === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = originalSession;
  });

  it("returns status=ok when OAUTH_ENCRYPTION_SECRET is set to a real value", () => {
    process.env.OAUTH_ENCRYPTION_SECRET = "a".repeat(32);
    expect(getEncryptionSecretStatus()).toEqual({ status: "ok", source: "OAUTH_ENCRYPTION_SECRET" });
  });

  it("returns status=missing when neither env var is set", () => {
    expect(getEncryptionSecretStatus()).toEqual({ status: "missing", source: "none" });
  });

  it("returns status=placeholder when OAUTH_ENCRYPTION_SECRET is __CHANGE_ME__", () => {
    process.env.OAUTH_ENCRYPTION_SECRET = "__CHANGE_ME__";
    expect(getEncryptionSecretStatus()).toEqual({ status: "placeholder", source: "OAUTH_ENCRYPTION_SECRET" });
  });

  it("returns status=fallback when only legacy SESSION_SECRET is set", () => {
    process.env.SESSION_SECRET = "a".repeat(32);
    expect(getEncryptionSecretStatus()).toEqual({ status: "fallback", source: "SESSION_SECRET" });
  });

  it("returns status=placeholder when SESSION_SECRET is __CHANGE_ME__ and OAUTH_ENCRYPTION_SECRET is unset", () => {
    process.env.SESSION_SECRET = "__CHANGE_ME__";
    expect(getEncryptionSecretStatus()).toEqual({ status: "placeholder", source: "SESSION_SECRET" });
  });

  it("prefers OAUTH_ENCRYPTION_SECRET when both are set", () => {
    process.env.OAUTH_ENCRYPTION_SECRET = "a".repeat(32);
    process.env.SESSION_SECRET = "b".repeat(32);
    expect(getEncryptionSecretStatus()).toEqual({ status: "ok", source: "OAUTH_ENCRYPTION_SECRET" });
  });
});

describe("assertOAuthEncryptionReady", () => {
  const originalOAuth = process.env.OAUTH_ENCRYPTION_SECRET;
  const originalSession = process.env.SESSION_SECRET;

  beforeEach(() => {
    delete process.env.OAUTH_ENCRYPTION_SECRET;
    delete process.env.SESSION_SECRET;
  });

  afterEach(() => {
    if (originalOAuth === undefined) delete process.env.OAUTH_ENCRYPTION_SECRET;
    else process.env.OAUTH_ENCRYPTION_SECRET = originalOAuth;
    if (originalSession === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = originalSession;
  });

  it("returns no warnings when status is ok", () => {
    process.env.OAUTH_ENCRYPTION_SECRET = "a".repeat(32);
    const result = assertOAuthEncryptionReady({ countOAuthCredentials: () => 0 });
    expect(result.warnings).toEqual([]);
  });

  it("returns a warning when secret is missing and DB has no credentials", () => {
    const result = assertOAuthEncryptionReady({ countOAuthCredentials: () => 0 });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/OAUTH_ENCRYPTION_SECRET is missing/);
  });

  it("returns a warning when secret is placeholder and DB has no credentials", () => {
    process.env.OAUTH_ENCRYPTION_SECRET = "__CHANGE_ME__";
    const result = assertOAuthEncryptionReady({ countOAuthCredentials: () => 0 });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/OAUTH_ENCRYPTION_SECRET is placeholder/);
  });

  it("throws when secret is missing and DB contains existing credentials", () => {
    expect(() => assertOAuthEncryptionReady({ countOAuthCredentials: () => 2 })).toThrow(
      /missing.*2 encrypted OAuth credential/,
    );
  });

  it("throws when secret is placeholder and DB contains existing credentials", () => {
    process.env.OAUTH_ENCRYPTION_SECRET = "__CHANGE_ME__";
    expect(() => assertOAuthEncryptionReady({ countOAuthCredentials: () => 1 })).toThrow(
      /placeholder.*1 encrypted OAuth credential/,
    );
  });

  it("warns about fallback when only SESSION_SECRET is set (never throws)", () => {
    process.env.SESSION_SECRET = "a".repeat(32);
    const result = assertOAuthEncryptionReady({ countOAuthCredentials: () => 5 });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/falling back to legacy SESSION_SECRET/);
  });

  it("tolerates countOAuthCredentials() throwing (treats as 0)", () => {
    const result = assertOAuthEncryptionReady({
      countOAuthCredentials: () => {
        throw new Error("db unavailable");
      },
    });
    expect(result.warnings).toHaveLength(1);
    // No throw — defensive DB read should not block startup warning path
  });
});

describe("b64url", () => {
  it("encodes a buffer using URL-safe base64 without padding", () => {
    // 0xfb 0xff -> standard base64 "+/8=" -> url-safe "-_8"
    const out = b64url(Buffer.from([0xfb, 0xff]));
    expect(out).toBe("-_8");
    expect(out).not.toMatch(/[+/=]/);
  });

  it("returns empty string for empty buffer", () => {
    expect(b64url(Buffer.alloc(0))).toBe("");
  });
});

describe("pkceVerifier", () => {
  it("produces a URL-safe string with no reserved base64 characters", () => {
    for (let i = 0; i < 16; i++) {
      const v = pkceVerifier();
      expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(v).not.toMatch(/[+/=]/);
    }
  });

  it("produces a verifier within RFC 7636 length bounds (43-128 chars)", () => {
    // 32 random bytes -> base64url length 43 (no padding)
    const v = pkceVerifier();
    expect(v.length).toBeGreaterThanOrEqual(43);
    expect(v.length).toBeLessThanOrEqual(128);
  });

  it("returns distinct values across calls (high entropy)", () => {
    const set = new Set<string>();
    for (let i = 0; i < 32; i++) set.add(pkceVerifier());
    expect(set.size).toBe(32);
  });
});

describe("pkceChallengeS256", () => {
  it("derives the challenge per RFC 7636: BASE64URL(SHA256(ASCII(verifier)))", async () => {
    const verifier = pkceVerifier();
    const expected = createHash("sha256").update(verifier, "ascii").digest().toString("base64url");
    await expect(pkceChallengeS256(verifier)).resolves.toBe(expected);
  });

  it("matches the RFC 7636 Appendix B test vector", async () => {
    // From RFC 7636 §4.6 / Appendix B
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const expected = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    await expect(pkceChallengeS256(verifier)).resolves.toBe(expected);
  });

  it("yields URL-safe output without padding", async () => {
    const challenge = await pkceChallengeS256("any-verifier-value");
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).not.toMatch(/[+/=]/);
  });

  it("is deterministic for a given verifier", async () => {
    const v = "a-stable-verifier";
    const a = await pkceChallengeS256(v);
    const b = await pkceChallengeS256(v);
    expect(a).toBe(b);
  });

  it("differs between distinct verifiers", async () => {
    const a = await pkceChallengeS256("verifier-one");
    const b = await pkceChallengeS256("verifier-two");
    expect(a).not.toBe(b);
  });
});

describe("sanitizeOAuthRedirect", () => {
  it("returns '/' when value is undefined", () => {
    expect(sanitizeOAuthRedirect(undefined)).toBe("/");
  });

  it("returns '/' when value is empty string", () => {
    expect(sanitizeOAuthRedirect("")).toBe("/");
  });

  it("preserves relative paths starting with '/'", () => {
    expect(sanitizeOAuthRedirect("/dashboard")).toBe("/dashboard");
    expect(sanitizeOAuthRedirect("/a/b?x=1#y")).toBe("/a/b?x=1#y");
  });

  it("rejects non-allowlisted absolute URLs by collapsing to '/'", () => {
    expect(sanitizeOAuthRedirect("https://evil.example.com/steal")).toBe("/");
    expect(sanitizeOAuthRedirect("http://attacker.com")).toBe("/");
  });

  it("allows localhost / 127.0.0.1 absolute URLs", () => {
    expect(sanitizeOAuthRedirect("http://localhost:3000/cb")).toBe("http://localhost:3000/cb");
    expect(sanitizeOAuthRedirect("http://127.0.0.1:8800/x")).toBe("http://127.0.0.1:8800/x");
  });

  it("allows IPv6 loopback [::1] absolute URLs (bracketed hostname)", () => {
    expect(sanitizeOAuthRedirect("http://[::1]:8800/cb")).toBe("http://[::1]:8800/cb");
    expect(sanitizeOAuthRedirect("http://[::1]/")).toBe("http://[::1]/");
  });

  it("allows Tailscale .ts.net hostnames", () => {
    expect(sanitizeOAuthRedirect("https://my-host.tailnet.ts.net/cb")).toBe("https://my-host.tailnet.ts.net/cb");
  });

  it("rejects host-relative paths that don't start with '/'", () => {
    expect(sanitizeOAuthRedirect("dashboard")).toBe("/");
  });

  it("rejects protocol-relative URLs (//host/path) as external", () => {
    // Browsers resolve "//host/path" against the current scheme and navigate
    // off-site, so the helper must NOT treat it as a safe relative redirect.
    expect(sanitizeOAuthRedirect("//evil.example.com/path")).toBe("/");
    expect(sanitizeOAuthRedirect("///deeply/nested")).toBe("/");
    expect(sanitizeOAuthRedirect("// ")).toBe("/");
  });

  it("still preserves single-slash relative paths after the // guard", () => {
    expect(sanitizeOAuthRedirect("/path")).toBe("/path");
    expect(sanitizeOAuthRedirect("/")).toBe("/");
  });
});

describe("appendOAuthQuery", () => {
  it("adds a new query parameter to a URL without existing query", () => {
    expect(appendOAuthQuery("https://example.com/cb", "code", "abc")).toBe("https://example.com/cb?code=abc");
  });

  it("adds a new query parameter alongside existing ones", () => {
    const out = appendOAuthQuery("https://example.com/cb?state=s1", "code", "abc");
    expect(out).toBe("https://example.com/cb?state=s1&code=abc");
  });

  it("overwrites an existing parameter with the same key", () => {
    const out = appendOAuthQuery("https://example.com/cb?code=old", "code", "new");
    expect(out).toBe("https://example.com/cb?code=new");
  });

  it("URL-encodes special characters in the value", () => {
    const out = appendOAuthQuery("https://example.com/cb", "next", "/path with space&x=1");
    const u = new URL(out);
    expect(u.searchParams.get("next")).toBe("/path with space&x=1");
    expect(out).toContain("next=");
    expect(out).not.toContain("next=/path with space&x=1"); // raw not allowed
  });

  it("throws on invalid URL input", () => {
    expect(() => appendOAuthQuery("not-a-url", "k", "v")).toThrow();
  });
});
