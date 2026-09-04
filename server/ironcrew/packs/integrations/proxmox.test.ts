import { describe, it, expect, vi, afterEach } from "vitest";
import { ProxmoxAdapter } from "./proxmox.ts";
import { PackIntegrationError } from "../pack-integration.ts";

/**
 * The secret every test checks for. It is deliberately distinctive: a grep
 * for it across an error message or a console line is then unambiguous.
 */
const TOKEN_SECRET = "d2f4c0c8-1111-2222-3333-444455556666";
const TOKEN_ID = "monitoring@pve!ironcrew";

interface FakeResponse {
  status?: number;
  /** Serialised as the body. Ignored when `text` is given. */
  json?: unknown;
  /** A raw body, for the "not JSON at all" case. */
  text?: string;
}

/**
 * A fetch that answers from a queue and records what it was asked.
 *
 * No socket: the point is to drive the adapter's real code path — URL
 * building, auth header, mapping, error surfacing — not to mock the adapter.
 */
function fakeFetch(responses: FakeResponse | FakeResponse[]) {
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    const status = next.status ?? 200;
    const body = next.text ?? JSON.stringify(next.json ?? null);
    return { ok: status < 400, status, text: async () => body } as unknown as Response;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

function adapter(responses: FakeResponse | FakeResponse[], overrides: Record<string, unknown> = {}) {
  const { impl, calls } = fakeFetch(responses);
  const pve = new ProxmoxAdapter({
    baseUrl: "https://pve.intern.example:8006/",
    tokenId: TOKEN_ID,
    tokenSecret: TOKEN_SECRET,
    fetchImpl: impl,
    ...overrides,
  });
  return { pve, calls };
}

const VERSION: FakeResponse = { json: { data: { version: "8.3.2", release: "8.3", repoid: "abc123" } } };

const NODES: FakeResponse = {
  json: {
    data: [
      {
        node: "pve-01",
        status: "online",
        cpu: 0.0363996043521266,
        maxcpu: 40,
        mem: 142374367232,
        maxmem: 270090743808,
        uptime: 15986715,
        type: "node",
      },
      // An offline node reports neither load nor uptime — Proxmox simply omits
      // the fields, which must not become a fake zero.
      { node: "pve-02", status: "offline" },
    ],
  },
};

const RESOURCES: FakeResponse = {
  json: {
    data: [
      {
        id: "qemu/100",
        type: "qemu",
        vmid: 100,
        name: "kunde-dc01",
        node: "pve-01",
        status: "running",
        maxmem: 8589934592,
      },
      { id: "lxc/201", type: "lxc", vmid: 201, name: "backup-proxy", node: "pve-02", status: "stopped" },
      {
        id: "qemu/900",
        type: "qemu",
        vmid: 900,
        name: "debian-12-tmpl",
        node: "pve-01",
        status: "stopped",
        template: 1,
      },
      // Nameless guest: the vmid is the only always-present identifier.
      { id: "qemu/101", type: "qemu", vmid: 101, node: "pve-01", status: "running" },
      // A storage row would never appear under type=vm, but a future Proxmox
      // release adding a third guest type must be skipped, not mis-mapped.
      { id: "sdn/zone1", type: "sdn", node: "pve-01", status: "ok" },
    ],
  },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ProxmoxAdapter", () => {
  it("identifies itself with the pack's integration key", () => {
    const { pve } = adapter(VERSION);
    expect(pve.key).toBe("proxmox");
    expect(pve.label).toBe("Proxmox VE");
  });

  it("builds the documented URL and the documented token header", async () => {
    const { pve, calls } = adapter(VERSION);
    await pve.testConnection();

    // The documented base path, with the trailing slash of the configured
    // base URL trimmed so this is never "…:8006//api2/json/version".
    expect(calls[0].url).toBe("https://pve.intern.example:8006/api2/json/version");
    expect(calls[0].url).not.toContain("8006//");

    const headers = calls[0].init.headers as Record<string, string>;
    // PVEAPIToken=USER@REALM!TOKENID=SECRET — https://pve.proxmox.com/wiki/Proxmox_VE_API
    expect(headers.Authorization).toBe(`PVEAPIToken=${TOKEN_ID}=${TOKEN_SECRET}`);
    expect(headers.Accept).toBe("application/json");
    expect(calls[0].init.method).toBe("GET");
  });

  it("asks the two list endpoints the documentation names", async () => {
    const { pve: nodes, calls: nodeCalls } = adapter(NODES);
    await nodes.listNodes();
    expect(nodeCalls[0].url).toBe("https://pve.intern.example:8006/api2/json/nodes");

    const { pve: guests, calls: guestCalls } = adapter(RESOURCES);
    await guests.listGuests();
    expect(guestCalls[0].url).toBe("https://pve.intern.example:8006/api2/json/cluster/resources?type=vm");
  });

  it("reports the version on a successful probe", async () => {
    const { pve } = adapter(VERSION);
    const status = await pve.testConnection();
    expect(status.ok).toBe(true);
    expect(status.version).toBe("8.3.2");
    expect(status.message).toContain("8.3.2");
  });

  it("still reports success when the version field is missing", async () => {
    const { pve } = adapter({ json: { data: {} } });
    const status = await pve.testConnection();
    expect(status.ok).toBe(true);
    expect(status.version).toBeUndefined();
  });

  it("maps nodes, and maps an absent metric to null rather than zero", async () => {
    const { pve } = adapter(NODES);
    const nodes = await pve.listNodes();

    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toEqual({
      name: "pve-01",
      status: "online",
      cpuUsage: 0.0363996043521266,
      cpuCores: 40,
      memoryUsedBytes: 142374367232,
      memoryTotalBytes: 270090743808,
      uptimeSeconds: 15986715,
    });
    // An offline node with no numbers must not look like a node at 0% load
    // with 0 bytes of RAM — that is a different, much more alarming claim.
    expect(nodes[1]).toMatchObject({ name: "pve-02", status: "offline", cpuUsage: null, uptimeSeconds: null });
  });

  it("maps VMs and containers, flags templates, and skips unknown types", async () => {
    const { pve } = adapter(RESOURCES);
    const guests = await pve.listGuests();

    expect(guests.map((g) => g.vmid)).toEqual([100, 201, 900, 101]);
    expect(guests[0]).toEqual({
      vmid: 100,
      name: "kunde-dc01",
      node: "pve-01",
      type: "qemu",
      status: "running",
      template: false,
    });
    expect(guests[1]).toMatchObject({ type: "lxc", node: "pve-02", status: "stopped", template: false });
    // A template always reads "stopped"; without the flag every template
    // lands on the operator's "why is this down" list.
    expect(guests[2]).toMatchObject({ vmid: 900, template: true });
    expect(guests[3].name).toBe("101");
    expect(guests.some((g) => g.node === "pve-01" && g.status === "ok")).toBe(false);
  });

  it("survives a response whose data is not a list", async () => {
    const { pve } = adapter({ json: { data: { unexpected: true } } });
    await expect(pve.listNodes()).resolves.toEqual([]);
  });

  it("says the token is wrong on 401, and says nothing else", async () => {
    const { pve } = adapter({ status: 401, text: "401 No ticket" });
    const status = await pve.testConnection();
    expect(status.ok).toBe(false);
    expect(status.message).toContain("401");
    expect(status.message).toMatch(/Token-ID und Secret/);
    await expect(pve.listNodes()).rejects.toBeInstanceOf(PackIntegrationError);
  });

  it("says the token lacks permissions on 403", async () => {
    const { pve } = adapter({ status: 403, text: "403 Permission check failed" });
    await expect(pve.listGuests()).rejects.toThrow(/Berechtigung/);
    await expect(pve.listGuests()).rejects.toThrow(/PVEAuditor/);
    // Wrong token and unprivileged token need opposite fixes, so the two
    // messages must not be interchangeable.
    expect((await pve.testConnection()).message).not.toMatch(/Token-ID und Secret/);
  });

  it("names the host on a 404, because that is usually a wrong base URL", async () => {
    const { pve } = adapter({ status: 404, text: "not found" });
    const status = await pve.testConnection();
    expect(status.message).toContain("pve.intern.example");
    expect(status.message).toContain("8006");
  });

  it("surfaces a non-JSON answer readably instead of crashing", async () => {
    // A reverse proxy in front of the cluster answers HTML, not JSON.
    const { pve } = adapter({ text: "<html><body>502 Bad Gateway</body></html>" });
    await expect(pve.listNodes()).rejects.toThrow(/kein JSON/);
    const status = await pve.testConnection();
    expect(status.ok).toBe(false);
  });

  it("surfaces a JSON answer that carries no data field", async () => {
    const { pve } = adapter({ json: { errors: { vmid: "invalid" } } });
    await expect(pve.listGuests()).rejects.toThrow(/data/);
  });

  it("times out instead of hanging the page", async () => {
    const hanging = (async (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("The operation was aborted.");
          err.name = "AbortError";
          reject(err);
        });
      })) as unknown as typeof fetch;

    const pve = new ProxmoxAdapter({
      baseUrl: "https://pve.intern.example:8006",
      tokenId: TOKEN_ID,
      tokenSecret: TOKEN_SECRET,
      fetchImpl: hanging,
      timeoutMs: 10,
    });

    const status = await pve.testConnection();
    expect(status.ok).toBe(false);
    expect(status.message).toMatch(/Zeitüberschreitung/);
  });

  it("names the host when the cluster cannot be reached at all", async () => {
    const pve = new ProxmoxAdapter({
      baseUrl: "https://pve.intern.example:8006",
      tokenId: TOKEN_ID,
      tokenSecret: TOKEN_SECRET,
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    const status = await pve.testConnection();
    expect(status.ok).toBe(false);
    expect(status.message).toContain("ECONNREFUSED");
  });

  it("reports a missing or malformed token instead of sending a broken header", async () => {
    const { pve: empty, calls: emptyCalls } = adapter(VERSION, { tokenSecret: "" });
    const emptyStatus = await empty.testConnection();
    expect(emptyStatus.ok).toBe(false);
    expect(emptyStatus.message).toMatch(/nicht konfiguriert/);
    // No request at all: a half-built credential must never leave the process.
    expect(emptyCalls).toHaveLength(0);

    const { pve: malformed } = adapter(VERSION, { tokenId: "ironcrew" });
    const malformedStatus = await malformed.testConnection();
    expect(malformedStatus.ok).toBe(false);
    expect(malformedStatus.message).toContain("USER@REALM!TOKENID");
  });

  it("rejects an empty base URL rather than probing the local host", () => {
    expect(() => adapter(VERSION, { baseUrl: "   " })).toThrow(PackIntegrationError);
  });

  it("never puts the token secret in a message and never logs anything", async () => {
    const spies = (["log", "info", "warn", "error", "debug", "trace"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {}),
    );

    // Every failure mode that could plausibly carry a credential outward: the
    // server echoing the request back, a redirect page, a refused socket.
    const cases: FakeResponse[] = [
      { status: 401, text: `401 authentication failure: PVEAPIToken=${TOKEN_ID}=${TOKEN_SECRET}` },
      { status: 403, text: "403 Permission check failed" },
      { status: 500, text: `internal error while handling PVEAPIToken=${TOKEN_ID}=${TOKEN_SECRET}` },
      { text: `<html>PVEAPIToken=${TOKEN_ID}=${TOKEN_SECRET}</html>` },
      { json: { data: null } },
    ];

    const messages: string[] = [];
    for (const response of cases) {
      const { pve } = adapter(response);
      messages.push((await pve.testConnection()).message);
      for (const call of [pve.listNodes(), pve.listGuests()]) {
        await call.then(
          () => undefined,
          (err: unknown) => messages.push(err instanceof Error ? err.message : String(err)),
        );
      }
    }
    // The happy path too — a success message is a message like any other.
    const { pve: ok } = adapter(VERSION);
    messages.push((await ok.testConnection()).message);
    await ok.listGuests();

    expect(messages.length).toBeGreaterThan(5);
    for (const message of messages) {
      expect(message).not.toContain(TOKEN_SECRET);
      expect(message).not.toContain("PVEAPIToken");
    }
    // An adapter that holds a token has no business writing to a log at all:
    // the one place a secret leaks without anybody noticing.
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
