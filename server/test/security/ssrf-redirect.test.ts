import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock node:dns BEFORE importing the module under test so assertSsrfSafeUrl
// uses the stub.
const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));
vi.mock("node:dns", () => ({
  default: { promises: { lookup: lookupMock } },
  promises: { lookup: lookupMock },
}));

// Override the dispatcher factory so we can: (a) count how many request-scoped
// dispatchers were created, and (b) return a MockAgent that intercepts undici
// fetch calls without standing up real sockets.  We import after vi.mock so
// the helper sees the mocked dns.
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import { safeFetch, __setDispatcherFactoryForTests, SsrfRedirectLimitError } from "../../security/safe-fetch.ts";
import { SsrfBlockedError } from "../../security/ssrf.ts";

let mockAgent: MockAgent;
let prevGlobal: ReturnType<typeof getGlobalDispatcher>;
let dispatcherCreates = 0;
let validatedUrls: string[] = [];

beforeEach(() => {
  lookupMock.mockReset();
  // By default, every public-looking lookup answers with a public IP.  Tests
  // override per case.
  lookupMock.mockResolvedValue([{ address: "203.0.113.10", family: 4 }]);

  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  prevGlobal = getGlobalDispatcher();
  setGlobalDispatcher(mockAgent);

  dispatcherCreates = 0;
  validatedUrls = [];

  // Test factory: count every instantiation and return MockAgent so undici
  // routes through the interceptor pool.  The pinned-lookup branch itself is
  // exercised by ssrf-dns-rebind.test.ts.
  __setDispatcherFactoryForTests((pin) => {
    dispatcherCreates += 1;
    validatedUrls.push(pin.url);
    return mockAgent as unknown as ReturnType<typeof getGlobalDispatcher> as never;
  });
});

afterEach(async () => {
  __setDispatcherFactoryForTests(null);
  setGlobalDispatcher(prevGlobal);
  await mockAgent.close().catch(() => {});
});

describe("safeFetch redirect re-validation (review #2)", () => {
  it("blocks 302 to 169.254.169.254 — metadata IP is never connected to", async () => {
    mockAgent
      .get("https://public.example.com")
      .intercept({ path: "/" })
      .reply(302, "", { headers: { location: "http://169.254.169.254/latest/meta-data/" } });

    await expect(safeFetch("https://public.example.com/")).rejects.toBeInstanceOf(SsrfBlockedError);

    expect(validatedUrls[0]).toBe("https://public.example.com/");
    // Only one pinned dispatcher was created (initial hop) — assertSsrfSafeUrl
    // threw on the metadata target before we could build a second dispatcher.
    expect(dispatcherCreates).toBe(1);
  });

  it("follows 302 to another public URL with a fresh pin and a single re-validation", async () => {
    lookupMock.mockImplementation(async (host: string) => {
      if (host === "first.example.com") return [{ address: "203.0.113.10", family: 4 }];
      if (host === "second.example.com") return [{ address: "198.51.100.20", family: 4 }];
      return [{ address: "203.0.113.99", family: 4 }];
    });

    mockAgent
      .get("https://first.example.com")
      .intercept({ path: "/a" })
      .reply(302, "", { headers: { location: "https://second.example.com/b" } });
    mockAgent.get("https://second.example.com").intercept({ path: "/b" }).reply(200, "ok");

    const res = await safeFetch("https://first.example.com/a");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");

    expect(validatedUrls).toEqual(["https://first.example.com/a", "https://second.example.com/b"]);
    expect(dispatcherCreates).toBe(2);
    expect(lookupMock).toHaveBeenCalledTimes(2);
    expect(lookupMock).toHaveBeenCalledWith("first.example.com", { all: true });
    expect(lookupMock).toHaveBeenCalledWith("second.example.com", { all: true });
  });

  it("throws SsrfRedirectLimitError after exceeding the hop limit (default 5)", async () => {
    for (let i = 0; i < 7; i++) {
      mockAgent
        .get("https://chain.example.com")
        .intercept({ path: `/${i}` })
        .reply(302, "", { headers: { location: `https://chain.example.com/${i + 1}` } });
    }

    await expect(safeFetch("https://chain.example.com/0")).rejects.toBeInstanceOf(SsrfRedirectLimitError);

    // Initial dispatcher + 5 followed redirects = 6.  On the 6th redirect we
    // throw before creating a 7th dispatcher.
    expect(dispatcherCreates).toBe(6);
  });

  it("IP-literal redirect target — assertSsrfSafeUrl is still called and blocks if private", async () => {
    mockAgent
      .get("https://public.example.com")
      .intercept({ path: "/" })
      .reply(302, "", { headers: { location: "http://10.0.0.5/internal" } });

    await expect(safeFetch("https://public.example.com/")).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("IP-literal redirect target — public IP literal is allowed and pin = literal", async () => {
    mockAgent
      .get("https://public.example.com")
      .intercept({ path: "/" })
      .reply(302, "", { headers: { location: "http://203.0.113.55/ok" } });
    mockAgent.get("http://203.0.113.55").intercept({ path: "/ok" }).reply(200, "literal-ok");

    const res = await safeFetch("https://public.example.com/");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("literal-ok");
    expect(validatedUrls).toEqual(["https://public.example.com/", "http://203.0.113.55/ok"]);
  });

  it('init.redirect: "error" throws on first redirect', async () => {
    mockAgent
      .get("https://public.example.com")
      .intercept({ path: "/" })
      .reply(302, "", { headers: { location: "https://public.example.com/next" } });

    await expect(safeFetch("https://public.example.com/", { redirect: "error" })).rejects.toBeInstanceOf(TypeError);
    expect(dispatcherCreates).toBe(1);
  });

  it('init.redirect: "manual" returns the redirect response without following', async () => {
    mockAgent
      .get("https://public.example.com")
      .intercept({ path: "/" })
      .reply(302, "", { headers: { location: "https://elsewhere.example.com/x" } });

    const res = await safeFetch("https://public.example.com/", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://elsewhere.example.com/x");
    expect(dispatcherCreates).toBe(1);
  });

  it("strips Authorization header on cross-origin hop", async () => {
    lookupMock.mockImplementation(async (host: string) => {
      if (host === "first.example.com") return [{ address: "203.0.113.10", family: 4 }];
      if (host === "second.example.com") return [{ address: "198.51.100.20", family: 4 }];
      return [{ address: "203.0.113.99", family: 4 }];
    });

    let secondAuth: string | string[] | undefined;
    mockAgent
      .get("https://first.example.com")
      .intercept({ path: "/a" })
      .reply(302, "", { headers: { location: "https://second.example.com/b" } });
    mockAgent
      .get("https://second.example.com")
      .intercept({ path: "/b" })
      .reply(200, (opts) => {
        const h = opts.headers as Record<string, string | string[]> | undefined;
        secondAuth = h?.["authorization"] ?? h?.["Authorization"];
        return "ok";
      });

    const res = await safeFetch("https://first.example.com/a", {
      headers: { Authorization: "Bearer secret-token" },
    });
    expect(res.status).toBe(200);
    expect(secondAuth).toBeUndefined();
  });

  it("preserves Authorization on same-origin hop", async () => {
    let secondAuth: string | string[] | undefined;
    mockAgent
      .get("https://first.example.com")
      .intercept({ path: "/a" })
      .reply(302, "", { headers: { location: "https://first.example.com/b" } });
    mockAgent
      .get("https://first.example.com")
      .intercept({ path: "/b" })
      .reply(200, (opts) => {
        const h = opts.headers as Record<string, string | string[]> | undefined;
        secondAuth = h?.["authorization"] ?? h?.["Authorization"];
        return "ok";
      });

    const res = await safeFetch("https://first.example.com/a", {
      headers: { Authorization: "Bearer keep-me" },
    });
    expect(res.status).toBe(200);
    expect(secondAuth).toBe("Bearer keep-me");
  });

  it("303 changes method to GET and drops body", async () => {
    let observed: { method?: string; body?: unknown } = {};
    mockAgent
      .get("https://api.example.com")
      .intercept({ path: "/post", method: "POST" })
      .reply(303, "", { headers: { location: "https://api.example.com/result" } });
    mockAgent
      .get("https://api.example.com")
      .intercept({ path: "/result" })
      .reply(200, (opts) => {
        observed = { method: opts.method, body: opts.body };
        return "ok";
      });

    const res = await safeFetch("https://api.example.com/post", {
      method: "POST",
      body: "payload",
    });
    expect(res.status).toBe(200);
    expect(observed.method).toBe("GET");
    expect(observed.body == null || observed.body === "").toBe(true);
  });

  it("307 preserves method and body", async () => {
    let observed: { method?: string; body?: unknown } = {};
    mockAgent
      .get("https://api.example.com")
      .intercept({ path: "/post", method: "POST" })
      .reply(307, "", { headers: { location: "https://api.example.com/again" } });
    mockAgent
      .get("https://api.example.com")
      .intercept({ path: "/again", method: "POST" })
      .reply(200, (opts) => {
        observed = { method: opts.method, body: opts.body };
        return "ok";
      });

    const res = await safeFetch("https://api.example.com/post", {
      method: "POST",
      body: "payload",
    });
    expect(res.status).toBe(200);
    expect(observed.method).toBe("POST");
    expect(String(observed.body ?? "")).toBe("payload");
  });
});
