import { describe, it, expect, vi } from "vitest";
import { TacticalRmmAdapter } from "./tactical-rmm.ts";
import { PackIntegrationError } from "../pack-integration.ts";

/**
 * The key this suite pretends is real. Deliberately a distinctive string so
 * that "does any message contain it" is a question with an honest answer.
 */
const API_KEY = "J57BXCFDA2WBCXH0XTELBR5KAI69CNCZ";
const BASE_URL = "https://api.rmm.intern.example";

interface Reply {
  status?: number;
  /** Serialised as JSON — this is the normal case. */
  body?: unknown;
  /** Raw text instead, for "the gateway answered HTML" cases. */
  text?: string;
}

/**
 * A fetch that answers with the given replies and records every request.
 *
 * Drives the adapter's real code path — URL building, headers, body, mapping,
 * error surfacing — without a socket, which is the only way to test an
 * adapter for a system that does not exist in CI.
 */
function fakeFetch(replies: Reply | Reply[]) {
  const queue = Array.isArray(replies) ? [...replies] : [replies];
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const reply = queue.length > 1 ? (queue.shift() as Reply) : queue[0];
    const status = reply.status ?? 200;
    return new Response(reply.text !== undefined ? reply.text : JSON.stringify(reply.body ?? null), { status });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

function adapter(replies: Reply | Reply[], baseUrl = `${BASE_URL}/`) {
  const { impl, calls } = fakeFetch(replies);
  return { rmm: new TacticalRmmAdapter({ baseUrl, apiKey: API_KEY, fetchImpl: impl }), calls };
}

/** A fetch that never answers, so the adapter's own AbortController fires. */
const hangingFetch = (async (_url: string | URL | Request, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      const err = new Error("This operation was aborted");
      err.name = "AbortError";
      reject(err);
    });
  })) as unknown as typeof fetch;

/** A fetch that fails with an error message carrying the key, as a proxy might. */
const leakyFetch = (async () => {
  throw new Error(`connect ECONNREFUSED (X-API-KEY: ${API_KEY})`);
}) as unknown as typeof fetch;

const AGENT_ROW = {
  agent_id: "6b1c9d0e",
  hostname: "WS-BUCHHALTUNG-01",
  client_name: "Muster Handel GmbH",
  site_name: "Zentrale",
  operating_system: "Windows 11 Pro, 64 bit (build 22631.4317)",
  status: "online",
  last_seen: "2026-09-04T07:12:33Z",
  needs_reboot: true,
};

const ALERT_ROW = {
  id: 412,
  severity: "error",
  alert_type: "availability",
  hostname: "SRV-DC-01",
  client: "Muster Handel GmbH",
  site: "Zentrale",
  message: "SRV-DC-01 ist offline",
  alert_time: "2026-09-03T22:41:02Z",
};

describe("TacticalRmmAdapter", () => {
  it("names itself with the key the pack declares", () => {
    const { rmm } = adapter({ body: "0.19.2" });
    expect(rmm.key).toBe("tactical-rmm");
    expect(rmm.label).toBe("Tactical RMM");
  });

  it("refuses to be built without a key", () => {
    // A blank key produces a 401 that reads exactly like a wrong key, and an
    // operator would then go looking for the wrong problem.
    expect(() => new TacticalRmmAdapter({ baseUrl: BASE_URL, apiKey: "  " })).toThrow(PackIntegrationError);
  });

  it("probes /core/version/ with X-API-KEY and reports the version", async () => {
    const { rmm, calls } = adapter({ body: "0.19.2" });
    const status = await rmm.testConnection();

    expect(calls[0].url).toBe("https://api.rmm.intern.example/core/version/");
    // Trailing slashes matter to Django; a trailing slash on the base URL
    // would produce "example//core/version/".
    expect(calls[0].url).not.toContain("example//");
    expect((calls[0].init.headers as Record<string, string>)["X-API-KEY"]).toBe(API_KEY);
    expect(calls[0].init.method).toBe("GET");
    expect(status).toMatchObject({ ok: true, version: "0.19.2" });
  });

  it("does not claim success when the URL reaches something that is not the API", async () => {
    const { rmm } = adapter({ body: { detail: "Willkommen" } });
    const status = await rmm.testConnection();
    expect(status.ok).toBe(false);
    expect(status.message).toContain("api.rmm.intern.example");
  });

  it("lists agents from /agents/?detail=true and maps every field", async () => {
    const { rmm, calls } = adapter({ body: [AGENT_ROW] });
    const agents = await rmm.listAgents();

    expect(calls[0].url).toBe("https://api.rmm.intern.example/agents/?detail=true");
    expect(calls[0].init.method).toBe("GET");
    expect((calls[0].init.headers as Record<string, string>)["X-API-KEY"]).toBe(API_KEY);
    expect(agents).toEqual([
      {
        agentId: "6b1c9d0e",
        hostname: "WS-BUCHHALTUNG-01",
        client: "Muster Handel GmbH",
        site: "Zentrale",
        operatingSystem: "Windows 11 Pro, 64 bit (build 22631.4317)",
        online: true,
        status: "online",
        lastSeen: "2026-09-04T07:12:33Z",
        pendingReboot: true,
      },
    ]);
  });

  it("treats an overdue agent as not online", async () => {
    // "overdue" means the agent missed its check-in window; calling that
    // online would put a machine nobody can reach on the healthy list.
    const { rmm } = adapter({ body: [{ ...AGENT_ROW, status: "overdue" }] });
    const [agent] = await rmm.listAgents();
    expect(agent.online).toBe(false);
    expect(agent.status).toBe("overdue");
  });

  it("leaves optional agent fields undefined rather than inventing them", async () => {
    const { rmm } = adapter({ body: [{ hostname: "LINUX-BUILD-01", status: "offline" }] });
    const [agent] = await rmm.listAgents();

    expect(agent).toEqual({
      agentId: undefined,
      hostname: "LINUX-BUILD-01",
      client: undefined,
      site: undefined,
      operatingSystem: undefined,
      online: false,
      status: "offline",
      lastSeen: undefined,
      // Absent is not "no": a missing field must not read as "reboot not needed".
      pendingReboot: undefined,
    });
  });

  it("keeps an agent that has no hostname instead of dropping it", async () => {
    const { rmm } = adapter({ body: [{ agent_id: "abc", status: "online" }] });
    const [agent] = await rmm.listAgents();
    expect(agent.agentId).toBe("abc");
    expect(agent.hostname).toBeTruthy();
  });

  it("returns an empty list when nothing is registered", async () => {
    const { rmm } = adapter({ body: [] });
    await expect(rmm.listAgents()).resolves.toEqual([]);
  });

  it("lists open alerts via PATCH /alerts/ with the unresolved filter", async () => {
    const { rmm, calls } = adapter({ body: [ALERT_ROW] });
    const alerts = await rmm.listAlerts();

    expect(calls[0].url).toBe("https://api.rmm.intern.example/alerts/");
    // Tactical RMM's own dashboard reads this table with PATCH, because the
    // filter travels in the body; AlertPerms treats PATCH like GET.
    expect(calls[0].init.method).toBe("PATCH");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ resolvedFilter: false, snoozedFilter: false });
    expect((calls[0].init.headers as Record<string, string>)["X-API-KEY"]).toBe(API_KEY);
    expect((calls[0].init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(alerts).toEqual([
      {
        id: 412,
        severity: "error",
        alertType: "availability",
        agent: "SRV-DC-01",
        client: "Muster Handel GmbH",
        site: "Zentrale",
        message: "SRV-DC-01 ist offline",
        raisedAt: "2026-09-03T22:41:02Z",
      },
    ]);
  });

  it("maps an alert that has no agent and no message", async () => {
    // Server-level alerts carry no assigned agent, and AlertSerializer sends
    // the missing fields as null.
    const { rmm } = adapter({ body: [{ id: 7, severity: "warning", hostname: null, message: null }] });
    const [alert] = await rmm.listAlerts();

    expect(alert).toEqual({
      id: 7,
      severity: "warning",
      alertType: undefined,
      agent: undefined,
      client: undefined,
      site: undefined,
      message: "",
      raisedAt: undefined,
    });
  });

  it("surfaces a rejected key readably, and reports rather than throws in testConnection", async () => {
    const { rmm } = adapter({ status: 401, text: "Unauthorized" });
    await expect(rmm.listAgents()).rejects.toBeInstanceOf(PackIntegrationError);
    await expect(rmm.listAgents()).rejects.toThrow(/401/);
    await expect(rmm.listAgents()).rejects.toThrow(/API-Key/);

    const status = await rmm.testConnection();
    expect(status.ok).toBe(false);
    expect(status.message).toMatch(/abgelehnt/);
  });

  it("says 'no permission' for a 403 rather than 'wrong key'", async () => {
    // A key whose role cannot list agents is a different day's work from a
    // key that is wrong, and the message has to say which.
    const { rmm } = adapter({ status: 403 });
    await expect(rmm.listAlerts()).rejects.toThrow(/Berechtigung/);
  });

  it("suggests the API host when the path 404s", async () => {
    const { rmm } = adapter({ status: 404 });
    await expect(rmm.listAgents()).rejects.toThrow(/404/);
  });

  it("carries the HTTP status on the error", async () => {
    const { rmm } = adapter({ status: 502 });
    await expect(rmm.listAgents()).rejects.toMatchObject({ status: 502 });
  });

  it("reports a body that is not JSON instead of crashing", async () => {
    const { rmm } = adapter({ text: "<html>502 Bad Gateway</html>" });
    await expect(rmm.listAgents()).rejects.toThrow(/kein JSON/);
  });

  it("reports a JSON body of an unexpected shape", async () => {
    const { rmm } = adapter({ body: { detail: "not a list" } });
    await expect(rmm.listAgents()).rejects.toThrow(/unerwartetes Format/);
  });

  it("names the instance when it cannot be reached", async () => {
    const rmm = new TacticalRmmAdapter({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    await expect(rmm.listAgents()).rejects.toThrow(/api\.rmm\.intern\.example/);
  });

  it("aborts and says so when the server does not answer", async () => {
    const rmm = new TacticalRmmAdapter({ baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl: hangingFetch, timeoutMs: 5 });
    await expect(rmm.listAgents()).rejects.toThrow(/Zeitüberschreitung/);
    expect(await rmm.testConnection()).toMatchObject({ ok: false });
  });

  it("never lets the API key into an error message", async () => {
    // The load-bearing test of this file. An error string is the one place a
    // secret leaks without anybody noticing, and the message need not have
    // been composed here to carry the key — a proxy that echoes request
    // headers, or a transport that stringifies the request, hands one over.
    const messages: string[] = [];

    const collect = async (run: () => Promise<unknown>) => {
      try {
        await run();
      } catch (err) {
        messages.push(err instanceof Error ? err.message : String(err));
      }
    };

    const echoed = `{"detail":"invalid key","X-API-KEY":"${API_KEY}"}`;
    for (const reply of [
      { status: 401, text: echoed },
      { status: 403, text: echoed },
      { status: 500, text: echoed },
      { status: 200, text: `<html>${API_KEY}</html>` },
    ] satisfies Reply[]) {
      const { rmm } = adapter(reply);
      await collect(() => rmm.listAgents());
      await collect(() => rmm.listAlerts());
      messages.push((await rmm.testConnection()).message);
    }

    const leaky = new TacticalRmmAdapter({ baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl: leakyFetch });
    await collect(() => leaky.listAgents());
    messages.push((await leaky.testConnection()).message);

    expect(messages.length).toBeGreaterThan(10);
    for (const message of messages) expect(message).not.toContain(API_KEY);
  });

  it("exposes no method that changes anything on an endpoint", async () => {
    // Guards the file header's promise: an RMM key that can run a script on
    // every managed machine is the most dangerous credential an MSP holds, so
    // this adapter is classed risk "read" and must stay read-only. A new
    // method named like a write fails here before it reaches review.
    const { rmm } = adapter({ body: [] });
    const surface = [
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(rmm)),
      ...Object.getOwnPropertyNames(rmm),
    ].filter((name) => name !== "constructor");

    const dangerous = /script|cmd|reboot|shutdown|wakeonlan|install|uninstall|delete|create|send/i;
    expect(surface.filter((name) => dangerous.test(name))).toEqual([]);

    // And the only non-GET request this adapter ever makes is the alert
    // listing, which is a read that Tactical RMM happens to spell as PATCH.
    const { rmm: probe, calls } = adapter({ body: [] });
    await probe.listAgents();
    await probe.listAlerts();
    expect(calls.map((call) => call.init.method)).toEqual(["GET", "PATCH"]);
  });
});
