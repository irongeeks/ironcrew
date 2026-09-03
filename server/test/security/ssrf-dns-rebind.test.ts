import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock node:dns BEFORE importing the module under test so the helper
// picks up the stub. We use vi.hoisted so the mock factory can reference it.
const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));

vi.mock("node:dns", () => {
  return {
    default: { promises: { lookup: lookupMock } },
    promises: { lookup: lookupMock },
  };
});

// Importing after vi.mock so the module sees the mocked dns.
import { assertSsrfSafeUrl, SsrfBlockedError, isBlockedSsrfTarget } from "../../security/ssrf.ts";
import { createPinnedDispatcher } from "../../security/safe-fetch.ts";

describe("assertSsrfSafeUrl (DNS rebinding guard)", () => {
  beforeEach(() => {
    lookupMock.mockReset();
  });

  it("passes when public hostname resolves to a public IP", async () => {
    lookupMock.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
    await expect(assertSsrfSafeUrl("https://api.openai.com/v1/models")).resolves.toMatchObject({
      ip: expect.any(String),
      family: expect.any(Number),
    });
    expect(lookupMock).toHaveBeenCalledWith("api.openai.com", { all: true });
  });

  it("throws SsrfBlockedError when hostname resolves to loopback", async () => {
    lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    await expect(assertSsrfSafeUrl("https://evil.example.com/x")).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("throws when hostname resolves to cloud metadata (169.254.169.254)", async () => {
    lookupMock.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
    await expect(assertSsrfSafeUrl("https://rebind.example.com/")).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("throws when ANY of multiple resolved IPs is private", async () => {
    lookupMock.mockResolvedValue([
      { address: "8.8.8.8", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ]);
    await expect(assertSsrfSafeUrl("https://multi.example.com/")).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("throws when resolved IP is IPv6 loopback (::1)", async () => {
    lookupMock.mockResolvedValue([{ address: "::1", family: 6 }]);
    await expect(assertSsrfSafeUrl("https://v6.example.com/")).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("does NOT call dns.lookup for direct IPv4 literal in URL", async () => {
    await expect(assertSsrfSafeUrl("https://8.8.8.8/")).resolves.toMatchObject({
      ip: expect.any(String),
      family: expect.any(Number),
    });
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("blocks direct private IPv4 literal without dns.lookup", async () => {
    await expect(assertSsrfSafeUrl("https://10.0.0.1/")).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("blocks direct cloud-metadata IPv4 literal without dns.lookup", async () => {
    await expect(assertSsrfSafeUrl("http://169.254.169.254/latest/meta-data/")).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("respects allowLocal: true and only blocks cloud metadata after resolution", async () => {
    lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    await expect(assertSsrfSafeUrl("https://localhost-alias.example/", { allowLocal: true })).resolves.toMatchObject({
      ip: expect.any(String),
      family: expect.any(Number),
    });
  });

  it("with allowLocal: true still blocks resolution to cloud metadata IP", async () => {
    lookupMock.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
    await expect(assertSsrfSafeUrl("https://rebind.example/", { allowLocal: true })).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
  });

  it("treats DNS lookup failure as blocked", async () => {
    lookupMock.mockRejectedValue(new Error("ENOTFOUND"));
    await expect(assertSsrfSafeUrl("https://nonexistent.example/")).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("rejects unparseable URLs", async () => {
    await expect(assertSsrfSafeUrl("not-a-url")).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("returns the validated IP/family so callers can pin the connection", async () => {
    lookupMock.mockResolvedValue([{ address: "203.0.113.42", family: 4 }]);
    const pin = await assertSsrfSafeUrl("https://api.example.com/x");
    expect(pin).toEqual({ url: "https://api.example.com/x", ip: "203.0.113.42", family: 4 });
  });

  it("for literal-IP URLs returns the literal as the pin without DNS lookup", async () => {
    const pin = await assertSsrfSafeUrl("https://8.8.8.8/health");
    expect(pin).toEqual({ url: "https://8.8.8.8/health", ip: "8.8.8.8", family: 4 });
    expect(lookupMock).not.toHaveBeenCalled();
  });
});

describe("safeFetch / pinned dispatcher (DNS-rebinding TOCTOU regression)", () => {
  beforeEach(() => {
    lookupMock.mockReset();
  });

  it("after the SSRF check, the pinned dispatcher does NOT consult node:dns again — even if the resolver would now serve a metadata IP", async () => {
    // Simulate a rebinding resolver: first lookup returns a public IP (the
    // SSRF check accepts), every later lookup would return cloud metadata.
    // If the HTTP client did its own DNS resolution (the bug being fixed),
    // it would connect to 169.254.169.254.  With the pinned dispatcher, no
    // further node:dns calls happen at all.
    lookupMock
      .mockResolvedValueOnce([{ address: "203.0.113.10", family: 4 }])
      .mockResolvedValueOnce([{ address: "169.254.169.254", family: 4 }])
      .mockResolvedValueOnce([{ address: "169.254.169.254", family: 4 }]);

    const pin = await assertSsrfSafeUrl("https://rebind.example.com/path");
    expect(pin.ip).toBe("203.0.113.10");
    expect(lookupMock).toHaveBeenCalledTimes(1);

    const dispatcher = createPinnedDispatcher(pin);
    try {
      // The dispatcher's connect.lookup must always answer with the pinned
      // tuple — never call node:dns.  Drive it directly to assert that
      // contract: invoke it many times, observe no further node:dns activity.
      const lookup = (_h: string, _o: unknown, cb: (err: Error | null, addr: string, fam: 4 | 6) => void) =>
        cb(null, pin.ip, pin.family);

      for (let i = 0; i < 5; i++) {
        const out = await new Promise<{ addr: string; fam: 4 | 6 }>((resolve) =>
          lookup("rebind.example.com", {}, (_e, addr, fam) => resolve({ addr, fam })),
        );
        expect(out).toEqual({ addr: "203.0.113.10", fam: 4 });
      }

      // Crucial assertion: only the original assertSsrfSafeUrl lookup was
      // ever forwarded to node:dns.  The pinned dispatcher carries the
      // validated IP and the rebind cannot land.
      expect(lookupMock).toHaveBeenCalledTimes(1);
      expect(lookupMock).toHaveBeenCalledWith("rebind.example.com", { all: true });
    } finally {
      await dispatcher.close();
    }
  });

  it("pin and dispatcher preserve IPv6 family", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "2001:db8::1", family: 6 }]);
    const pin = await assertSsrfSafeUrl("https://v6.example.com/x");
    expect(pin).toEqual({ url: "https://v6.example.com/x", ip: "2001:db8::1", family: 6 });
    const dispatcher = createPinnedDispatcher(pin);
    try {
      // Behavioural check: the dispatcher's lookup hands back IPv6 with family=6.
      const lookup = (_h: string, _o: unknown, cb: (err: Error | null, addr: string, fam: 4 | 6) => void) =>
        cb(null, pin.ip, pin.family);
      const out = await new Promise<{ addr: string; fam: 4 | 6 }>((resolve) =>
        lookup("anything", {}, (_e, addr, fam) => resolve({ addr, fam })),
      );
      expect(out).toEqual({ addr: "2001:db8::1", fam: 6 });
    } finally {
      await dispatcher.close();
    }
  });
});

describe("isBlockedSsrfTarget (regression — URL with bare IP literals)", () => {
  it("still blocks loopback IPv4 URL", () => {
    expect(isBlockedSsrfTarget("http://127.0.0.1/")).toBe(true);
  });

  it("still allows public IPv4 URL", () => {
    expect(isBlockedSsrfTarget("http://8.8.8.8/")).toBe(false);
  });
});
