import { describe, it, expect, vi } from "vitest";
import { UnifiAdapter } from "./unifi.ts";
import { PackIntegrationError } from "../pack-integration.ts";

const API_KEY = "sk-unifi-SUPERGEHEIM-0123456789";
const BASE = "https://udm.intern.example";
const PREFIX = "/proxy/network/integration/v1";

/** A recorded request, so a test can assert the URL and the headers verbatim. */
interface Call {
  url: string;
  init?: RequestInit;
}

type Answer = { status?: number; body?: unknown; text?: string };

/**
 * A fetch that answers by path.
 *
 * Keyed on the path rather than call order, because `listDevices()` and
 * `listClients()` first resolve the site — a queue of answers would silently
 * shift the moment that lookup is added or cached, and the test would pass for
 * the wrong reason.
 */
function fakeFetch(routes: Record<string, Answer>) {
  const calls: Call[] = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    calls.push({ url: href, init });
    const path = href.slice(BASE.length + PREFIX.length).split("?")[0];
    const answer = routes[path];
    if (!answer) throw new Error(`unrouted: ${href}`);
    const status = answer.status ?? 200;
    const text = answer.text ?? JSON.stringify(answer.body ?? {});
    return {
      ok: status < 400,
      status,
      text: async () => text,
    } as unknown as Response;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

function page(data: unknown[]) {
  return { offset: 0, limit: 200, count: data.length, totalCount: data.length, data };
}

const SITES = page([
  { id: "11111111-1111-4111-8111-111111111111", internalReference: "zweigstelle", name: "Zweigstelle" },
  { id: "22222222-2222-4222-8222-222222222222", internalReference: "default", name: "Hauptstandort" },
]);

const DEFAULT_SITE_ID = "22222222-2222-4222-8222-222222222222";

function adapter(routes: Record<string, Answer>, opts: { site?: string } = {}) {
  const { impl, calls } = fakeFetch(routes);
  return {
    unifi: new UnifiAdapter({ baseUrl: `${BASE}/`, apiKey: API_KEY, fetchImpl: impl, ...opts }),
    calls,
  };
}

describe("UnifiAdapter — request shape", () => {
  it("sends the API key as X-API-KEY and never in the URL", async () => {
    const { unifi, calls } = adapter({ "/info": { body: { applicationVersion: "10.3.58" } } });
    await unifi.testConnection();

    expect(calls[0].url).toBe(`${BASE}${PREFIX}/info`);
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers["X-API-KEY"]).toBe(API_KEY);
    expect(headers.Accept).toBe("application/json");
    // A key in a query string ends up in every proxy and access log on the way.
    expect(calls[0].url).not.toContain(API_KEY);
  });

  it("trims a trailing slash off the base URL so the path is never doubled", async () => {
    const { unifi, calls } = adapter({ "/info": { body: { applicationVersion: "10.3.58" } } });
    await unifi.testConnection();
    expect(calls[0].url).not.toContain("example//");
  });

  it("uses GET only — this adapter never writes", async () => {
    const { unifi, calls } = adapter({
      "/sites": { body: SITES },
      [`/sites/${DEFAULT_SITE_ID}/devices`]: { body: page([]) },
    });
    await unifi.listDevices();
    expect(calls.map((c) => c.init?.method)).toEqual(["GET", "GET"]);
  });

  it("exposes the key and label the pack declaration matches on", () => {
    const { unifi } = adapter({});
    expect(unifi.key).toBe("unifi");
    expect(unifi.label).toBe("UniFi Network");
  });

  it("refuses to be constructed without a key rather than sending an anonymous request", () => {
    expect(() => new UnifiAdapter({ baseUrl: BASE, apiKey: "  " })).toThrow(PackIntegrationError);
  });
});

describe("UnifiAdapter — site defaulting", () => {
  it("prefers the site whose internalReference is 'default'", async () => {
    const { unifi, calls } = adapter({
      "/sites": { body: SITES },
      [`/sites/${DEFAULT_SITE_ID}/devices`]: { body: page([]) },
    });
    await unifi.listDevices();

    expect(calls[0].url).toContain(`${PREFIX}/sites?`);
    expect(calls[1].url).toContain(`/sites/${DEFAULT_SITE_ID}/devices`);
  });

  it("matches a configured site by its short name", async () => {
    const { unifi, calls } = adapter(
      {
        "/sites": { body: SITES },
        "/sites/11111111-1111-4111-8111-111111111111/clients": { body: page([]) },
      },
      { site: "zweigstelle" },
    );
    await unifi.listClients();
    expect(calls[1].url).toContain("/sites/11111111-1111-4111-8111-111111111111/clients");
  });

  it("uses a configured UUID verbatim, without a site listing", async () => {
    const { unifi, calls } = adapter(
      { [`/sites/${DEFAULT_SITE_ID}/devices`]: { body: page([]) } },
      { site: DEFAULT_SITE_ID },
    );
    await unifi.listDevices();
    // A key scoped to one site may not be allowed to list sites at all.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain(`/sites/${DEFAULT_SITE_ID}/devices`);
  });

  it("resolves the site once and reuses it", async () => {
    const { unifi, calls } = adapter({
      "/sites": { body: SITES },
      [`/sites/${DEFAULT_SITE_ID}/devices`]: { body: page([]) },
      [`/sites/${DEFAULT_SITE_ID}/clients`]: { body: page([]) },
    });
    await unifi.listDevices();
    await unifi.listClients();
    expect(calls.filter((c) => c.url.includes(`${PREFIX}/sites?`))).toHaveLength(1);
  });

  it("names the sites it does know when the configured one is unknown", async () => {
    const { unifi } = adapter({ "/sites": { body: SITES } }, { site: "gibtsnicht" });
    await expect(unifi.listClients()).rejects.toThrow(/Verfügbar: zweigstelle, default/);
  });
});

describe("UnifiAdapter — mapping", () => {
  it("maps sites", async () => {
    const { unifi } = adapter({ "/sites": { body: SITES } });
    expect(await unifi.listSites()).toEqual([
      { id: "11111111-1111-4111-8111-111111111111", internalReference: "zweigstelle", name: "Zweigstelle" },
      { id: DEFAULT_SITE_ID, internalReference: "default", name: "Hauptstandort" },
    ]);
  });

  it("maps a device, including the derived adopted flag", async () => {
    const { unifi } = adapter({
      "/sites": { body: SITES },
      [`/sites/${DEFAULT_SITE_ID}/devices`]: {
        body: page([
          {
            id: "aaaaaaaa-0000-4000-8000-000000000001",
            name: "AP Buero",
            model: "U6PRO",
            macAddress: "94:2a:6f:26:c6:ca",
            ipAddress: "192.168.10.21",
            state: "ONLINE",
            firmwareVersion: "6.6.55",
            firmwareUpdatable: true,
          },
          {
            id: "aaaaaaaa-0000-4000-8000-000000000002",
            name: "Neues Gerät",
            model: "USW24",
            macAddress: "94:2a:6f:26:c6:cb",
            state: "PENDING_ADOPTION",
          },
        ]),
      },
    });

    const [ap, pending] = await unifi.listDevices();
    expect(ap).toMatchObject({
      name: "AP Buero",
      model: "U6PRO",
      macAddress: "94:2a:6f:26:c6:ca",
      state: "ONLINE",
      adopted: true,
      firmwareVersion: "6.6.55",
      firmwareUpdatable: true,
    });
    expect(pending.adopted).toBe(false);
    // The list endpoint carries no uptime; it must stay absent, not become 0.
    expect(ap.uptimeSec).toBeUndefined();
  });

  it("survives a device row with every optional field missing", async () => {
    const { unifi } = adapter({
      "/sites": { body: SITES },
      [`/sites/${DEFAULT_SITE_ID}/devices`]: { body: page([{ id: "x", name: "y", model: "z", macAddress: "m" }]) },
    });
    const [device] = await unifi.listDevices();
    expect(device.ipAddress).toBeUndefined();
    expect(device.firmwareVersion).toBeUndefined();
    expect(device.firmwareUpdatable).toBeUndefined();
    // An unknown state must not read as "adopted: false" by accident either.
    expect(device).toMatchObject({ state: "UNKNOWN", adopted: true });
  });

  it("fetches uptime per device only when asked", async () => {
    const routes = {
      "/sites": { body: SITES },
      [`/sites/${DEFAULT_SITE_ID}/devices`]: {
        body: page([{ id: "dev-1", name: "AP", model: "U6PRO", macAddress: "aa", state: "ONLINE" }]),
      },
      [`/sites/${DEFAULT_SITE_ID}/devices/dev-1/statistics/latest`]: { body: { uptimeSec: 91_234 } },
    };
    const { unifi, calls } = adapter(routes);
    const [device] = await unifi.listDevices({ withUptime: true });

    expect(device.uptimeSec).toBe(91_234);
    expect(calls.some((c) => c.url.endsWith("/devices/dev-1/statistics/latest"))).toBe(true);
  });

  it("maps wired, wireless and VPN clients differently", async () => {
    const { unifi } = adapter({
      "/sites": { body: SITES },
      [`/sites/${DEFAULT_SITE_ID}/clients`]: {
        body: page([
          {
            id: "c1",
            name: "buchhaltung-pc",
            type: "WIRED",
            macAddress: "aa:bb:cc:dd:ee:01",
            ipAddress: "192.168.10.50",
            connectedAt: "2026-08-31T07:12:00Z",
            uplinkDeviceId: "sw-1",
            access: { type: "DEFAULT" },
          },
          {
            id: "c2",
            name: "gast-handy",
            type: "WIRELESS",
            macAddress: "aa:bb:cc:dd:ee:02",
            access: { type: "GUEST" },
          },
          { id: "c3", name: "aussendienst", type: "VPN", ipAddress: "10.8.0.4" },
        ]),
      },
    });

    const [wired, wireless, vpn] = await unifi.listClients();
    expect(wired).toMatchObject({
      name: "buchhaltung-pc",
      connection: "wired",
      wired: true,
      macAddress: "aa:bb:cc:dd:ee:01",
      ipAddress: "192.168.10.50",
      connectedAt: "2026-08-31T07:12:00Z",
      accessType: "DEFAULT",
      uplinkDeviceId: "sw-1",
    });
    expect(wireless).toMatchObject({ connection: "wireless", wired: false, accessType: "GUEST" });
    expect(wireless.ipAddress).toBeUndefined();
    expect(wireless.connectedAt).toBeUndefined();
    // A VPN connection is neither wired nor wireless; `false` would file it as
    // wireless, and it has no client MAC at all.
    expect(vpn).toMatchObject({ connection: "vpn", ipAddress: "10.8.0.4" });
    expect(vpn.wired).toBeUndefined();
    expect(vpn.macAddress).toBeUndefined();
  });

  it("does not choke on a client type it has never heard of", async () => {
    const { unifi } = adapter({
      "/sites": { body: SITES },
      [`/sites/${DEFAULT_SITE_ID}/clients`]: { body: page([{ id: "c9", name: "was auch immer", type: "QUANTUM" }]) },
    });
    const [client] = await unifi.listClients();
    expect(client.connection).toBe("unknown");
    expect(client.wired).toBeUndefined();
  });

  it("walks the offset/limit pages until totalCount is reached", async () => {
    const calls: Call[] = [];
    const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      calls.push({ url: href, init });
      const offset = Number(new URL(href).searchParams.get("offset"));
      const data =
        offset === 0
          ? [{ id: "s1", name: "A", internalReference: "a" }]
          : [{ id: "s2", name: "B", internalReference: "b" }];
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ offset, limit: 200, count: 1, totalCount: 2, data }),
      } as unknown as Response;
    });
    const unifi = new UnifiAdapter({ baseUrl: BASE, apiKey: API_KEY, fetchImpl: impl as unknown as typeof fetch });

    expect((await unifi.listSites()).map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(calls[0].url).toContain("offset=0&limit=200");
    expect(calls[1].url).toContain("offset=1&limit=200");
  });

  it("stops on an empty page even when totalCount lies", async () => {
    const { unifi, calls } = adapter({ "/sites": { body: { totalCount: 9999, data: [] } } });
    // Without this guard a wrong totalCount would page forever and hang the
    // operator's Settings panel instead of answering it.
    expect(await unifi.listSites()).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});

describe("UnifiAdapter — failures an operator can act on", () => {
  it("reports a rejected API key without echoing it", async () => {
    const { unifi } = adapter({ "/info": { status: 401, body: { statusName: "UNAUTHORIZED" } } });
    const status = await unifi.testConnection();

    expect(status.ok).toBe(false);
    expect(status.message).toMatch(/API-Schlüssel/);
    expect(status.message).toMatch(/401/);
  });

  it("distinguishes 403 from 401 — a valid key that may not read this site", async () => {
    const { unifi } = adapter({ "/sites": { status: 403 } });
    await expect(unifi.listSites()).rejects.toThrow(/403/);
    await expect(unifi.listSites()).rejects.toBeInstanceOf(PackIntegrationError);
  });

  it("explains a 404 as 'this is not a UniFi OS console'", async () => {
    const { unifi } = adapter({ "/info": { status: 404 } });
    const status = await unifi.testConnection();
    // The legacy /api/login controller answers 404 here, and silently falling
    // back to that undocumented API is how an adapter starts lying.
    expect(status.message).toMatch(/UniFi OS/);
    expect(status.message).toMatch(/404/);
  });

  it("surfaces a non-JSON answer readably instead of crashing", async () => {
    const { unifi } = adapter({ "/info": { text: "<html>502 Bad Gateway</html>" } });
    const status = await unifi.testConnection();
    expect(status.ok).toBe(false);
    expect(status.message).toMatch(/kein JSON/);
  });

  it("turns a timeout into a timeout message, not a stack trace", async () => {
    const abort = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    const unifi = new UnifiAdapter({
      baseUrl: BASE,
      apiKey: API_KEY,
      timeoutMs: 25,
      fetchImpl: (async () => {
        throw abort;
      }) as unknown as typeof fetch,
    });
    const status = await unifi.testConnection();
    expect(status.message).toMatch(/Zeitüberschreitung nach 25 ms/);
  });

  it("names the console when it cannot be reached at all", async () => {
    const unifi = new UnifiAdapter({
      baseUrl: BASE,
      apiKey: API_KEY,
      fetchImpl: (async () => {
        throw new Error("self-signed certificate in certificate chain");
      }) as unknown as typeof fetch,
    });
    const status = await unifi.testConnection();
    // TLS verification is never disabled, so a self-signed console shows up
    // here — as the certificate error, which is the honest answer.
    expect(status.ok).toBe(false);
    expect(status.message).toMatch(/self-signed certificate/);
  });

  it("reports the version on a healthy console", async () => {
    const { unifi } = adapter({ "/info": { body: { applicationVersion: "10.3.58" } } });
    expect(await unifi.testConnection()).toMatchObject({
      ok: true,
      version: "10.3.58",
    });
  });

  it("NEVER puts the API key in any error message", async () => {
    const failures: Answer[] = [
      { status: 401 },
      { status: 403 },
      { status: 404 },
      { status: 429 },
      { status: 500, body: { message: `key was ${API_KEY}` } },
      { text: "<html>nope</html>" },
    ];

    for (const failure of failures) {
      const { unifi } = adapter({ "/info": failure, "/sites": failure });
      const status = await unifi.testConnection();
      expect(status.ok).toBe(false);
      // Including the 500 case: the response body is never quoted back,
      // because a body is exactly where a future firmware could echo the key,
      // and an error message is what gets pasted into a ticket.
      expect(status.message).not.toContain(API_KEY);

      await expect(unifi.listSites()).rejects.toSatisfy(
        (err: unknown) => err instanceof Error && !err.message.includes(API_KEY),
      );
    }
  });

  it("carries the key in the header and nowhere else, on every call it makes", async () => {
    const { unifi, calls } = adapter({
      "/sites": { body: SITES },
      [`/sites/${DEFAULT_SITE_ID}/devices`]: {
        body: page([{ id: "dev-1", name: "AP", model: "U6PRO", macAddress: "aa", state: "ONLINE" }]),
      },
      [`/sites/${DEFAULT_SITE_ID}/devices/dev-1/statistics/latest`]: { body: { uptimeSec: 1 } },
      [`/sites/${DEFAULT_SITE_ID}/clients`]: { body: page([]) },
    });
    await unifi.listDevices({ withUptime: true });
    await unifi.listClients();

    expect(calls.length).toBeGreaterThan(3);
    for (const call of calls) {
      // A URL reaches proxy and access logs; a request body reaches error
      // reporters. The header reaches neither by default.
      expect(call.url).not.toContain(API_KEY);
      expect(String(call.init?.body ?? "")).not.toContain(API_KEY);
      expect((call.init?.headers as Record<string, string>)["X-API-KEY"]).toBe(API_KEY);
    }
  });
});
