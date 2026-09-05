import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createTestDb } from "../domain/test-db.ts";
import { CompanyOrchestrator } from "../orchestrator/company.ts";
import { BusinessDashboardService } from "./business-dashboard.ts";
import { ProxmoxAdapter } from "./integrations/proxmox.ts";
import { TacticalRmmAdapter } from "./integrations/tactical-rmm.ts";
import { SevdeskAdapter } from "./integrations/sevdesk.ts";
import { LexwareOfficeAdapter } from "./integrations/lexware-office.ts";
import { UnifiAdapter } from "./integrations/unifi.ts";
import type { PackIntegrationAdapter } from "./pack-integration.ts";
import { findPack } from "./catalog.ts";

let db: DatabaseSync;
let company: CompanyOrchestrator;
let companyId: string;
let agentId: string;
let adapters: Map<string, PackIntegrationAdapter>;
let service: BusinessDashboardService;
const response = (body: unknown) => new Response(JSON.stringify(body));
beforeEach(() => {
  db = createTestDb();
  company = new CompanyOrchestrator(db);
  companyId = company.seedCompany({ name: "Dashboard Test", slug: "dashboard-test" });
  agentId = company.listAgents(companyId)[0]!.id;
  adapters = new Map();
  service = new BusinessDashboardService({
    db,
    companyId,
    getAdapter: (key) => adapters.get(key),
    gate: (agent, tool) => company.requestToolUse(companyId, agent, tool),
    agents: () => company.listAgents(companyId).map((agent) => ({ id: agent.id, displayName: agent.display_name })),
  });
});
afterEach(() => db.close());
function install(key = "msp") {
  company.packs.install(companyId, findPack(key)!, { actorId: "ceo" });
}
function grant(key: string, requiresApproval = false) {
  const tool = company.tools.byKey(companyId, key)!;
  company.tools.grant({ toolId: tool.id, agentId, requiresApproval });
}
function source(id: string) {
  return service.snapshot().sources.find((item) => item.id === id)!;
}
const proxmox = (fetchImpl: typeof fetch) =>
  new ProxmoxAdapter({
    baseUrl: "https://pve.example.test",
    tokenId: "reader@pve!audit",
    tokenSecret: "fixture-secret",
    fetchImpl,
  });

describe("business source refresh through actual adapter transport and tool gate", () => {
  it("never contacts providers on snapshot and distinguishes missing pack from configuration", () => {
    const transport = vi.fn<typeof fetch>(async () => response({ data: [] }));
    adapters.set("proxmox", proxmox(transport));
    expect(source("proxmox").state).toBe("not_installed");
    install();
    expect(source("proxmox").state).toBe("not_refreshed");
    expect(source("sevdesk").state).toBe("not_installed");
    expect(source("rmm-agents").state).toBe("not_configured");
    expect(transport).not.toHaveBeenCalled();
  });
  it("denies ungranted or disabled tools before transport and records the owner and correlation", async () => {
    install();
    const transport = vi.fn<typeof fetch>(async () => response({ data: [] }));
    adapters.set("proxmox", proxmox(transport));
    await service.refresh("proxmox", agentId, "ceo");
    expect(source("proxmox").state).toBe("denied");
    expect(transport).not.toHaveBeenCalled();
    const audit = db
      .prepare("SELECT actor_id,correlation_id,outcome FROM crew_audit_events WHERE action='business.source.refresh'")
      .get();
    expect(audit).toMatchObject({ actor_id: "ceo", outcome: "denied", correlation_id: expect.any(String) });
  });
  it("uses actual Proxmox request, omits templates, and exposes only source rows", async () => {
    install();
    grant("proxmox.inventory");
    const transport = vi.fn<typeof fetch>(async () =>
      response({
        data: [
          { vmid: 17, type: "qemu", status: "running", name: "Build 17" },
          { vmid: 18, type: "lxc", status: "stopped", name: "API 18" },
          { vmid: 19, type: "qemu", status: "stopped", template: 1 },
        ],
      }),
    );
    adapters.set("proxmox", proxmox(transport));
    await service.refresh("proxmox", agentId, "ceo");
    expect(source("proxmox")).toMatchObject({
      state: "ok",
      fetchedAt: expect.any(Number),
      records: [
        { id: "17", label: "Build 17", status: "running" },
        { id: "18", label: "API 18", status: "stopped" },
      ],
    });
    expect(source("proxmox").metrics.map((metric) => metric.value)).toEqual([2, 1]);
    expect(transport.mock.calls[0]?.[0]).toBe("https://pve.example.test/api2/json/cluster/resources?type=vm");
    expect(JSON.stringify(service.snapshot())).not.toContain("fixture-secret");
  });
  it("replaces previous values on malformed responses, never reports failure as zero", async () => {
    install();
    grant("proxmox.inventory");
    const transport = vi
      .fn()
      .mockResolvedValueOnce(response({ data: [] }))
      .mockResolvedValueOnce(response({ data: { unexpected: true } }));
    adapters.set("proxmox", proxmox(transport));
    await service.refresh("proxmox", agentId, "ceo");
    expect(source("proxmox").metrics[0]?.value).toBe(0);
    await service.refresh("proxmox", agentId, "ceo");
    expect(source("proxmox")).toMatchObject({ state: "error", metrics: [], records: [], fetchedAt: null });
  });
  it("caps drilldown at 100 and distinguishes sample from inventory count", async () => {
    install();
    grant("proxmox.inventory");
    adapters.set(
      "proxmox",
      proxmox(async () =>
        response({ data: Array.from({ length: 141 }, (_, id) => ({ vmid: id, type: "qemu", status: "running" })) }),
      ),
    );
    await service.refresh("proxmox", agentId, "ceo");
    expect(source("proxmox").records).toHaveLength(100);
    expect(source("proxmox").limited).toBe(true);
    expect(source("proxmox").metrics[0]?.value).toBe(141);
  });
  it("keeps unknown RMM status separate from offline and performs its read-only alert filter", async () => {
    install();
    grant("rmm.agents");
    grant("rmm.alerts");
    const transport = vi.fn(async (url: string | URL | Request) =>
      String(url).includes("/alerts/")
        ? response([{ id: 1, severity: "error", hostname: "node-a" }])
        : response([{ hostname: "node-a", status: "online" }, { hostname: "node-b" }]),
    );
    adapters.set(
      "tactical-rmm",
      new TacticalRmmAdapter({ baseUrl: "https://rmm.example.test", apiKey: "fixture-token", fetchImpl: transport }),
    );
    await service.refresh("rmm-agents", agentId, "ceo");
    await service.refresh("rmm-alerts", agentId, "ceo");
    expect(source("rmm-agents").metrics.map((metric) => metric.value)).toEqual([2, 1]);
    expect(source("rmm-alerts").metrics.map((metric) => metric.value)).toEqual([1, 1]);
  });
  it("presents sevDesk reported total separately from first page without summing money", async () => {
    install("finance-de");
    grant("sevdesk.invoice");
    const transport = vi.fn<typeof fetch>(async () =>
      response({ objects: [{ id: "9", invoiceNumber: "RE-9", status: "200", sumGross: "1234.5678" }], total: "273" }),
    );
    adapters.set("sevdesk", new SevdeskAdapter({ apiKey: "fixture-token", fetchImpl: transport }));
    await service.refresh("sevdesk", agentId, "ceo");
    expect(source("sevdesk").metrics.map((metric) => metric.value)).toEqual([1, 273]);
    expect(source("sevdesk").limited).toBe(true);
    expect(String(transport.mock.calls[0]?.[0])).toContain("status=200");
    expect(JSON.stringify(source("sevdesk"))).not.toContain("1234.5678");
  });
  it("keeps Lexware overdue count limited to the loaded page", async () => {
    install("finance-de");
    grant("lexware.vouchers");
    adapters.set(
      "lexware-office",
      new LexwareOfficeAdapter({
        apiKey: "fixture-token",
        fetchImpl: async () =>
          response({
            content: [{ id: "invoice-a", voucherStatus: "overdue" }],
            number: 0,
            totalPages: 5,
            last: false,
          }),
      }),
    );
    await service.refresh("lexware", agentId, "ceo");
    expect(source("lexware").state).toBe("ok");
    expect(source("lexware").limited).toBe(true);
    expect(source("lexware").metrics.map((metric) => metric.value)).toEqual([1, 1]);
  });
  it("limits UniFi to one device page rather than silently traversing an estate", async () => {
    install();
    grant("unifi.devices");
    const transport = vi.fn<typeof fetch>(async () =>
      response({ data: [{ id: "switch-a", name: "Switch A", state: "ONLINE" }], totalCount: 900 }),
    );
    adapters.set(
      "unifi",
      new UnifiAdapter({
        baseUrl: "https://unifi.example.test",
        apiKey: "fixture-token",
        site: "123e4567-e89b-12d3-a456-426614174000",
        fetchImpl: transport,
      }),
    );
    await service.refresh("unifi", agentId, "ceo");
    expect(source("unifi").state).toBe("ok");
    expect(source("unifi").limited).toBe(true);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("rejects a foreign agent and prevents concurrent refresh for one source", async () => {
    install();
    grant("proxmox.inventory");
    let resolve!: (value: Response) => void;
    adapters.set(
      "proxmox",
      proxmox(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      ),
    );
    await expect(service.refresh("proxmox", "foreign-agent", "ceo")).rejects.toMatchObject({ status: 400 });
    const first = service.refresh("proxmox", agentId, "ceo");
    await expect(service.refresh("proxmox", agentId, "ceo")).rejects.toMatchObject({ status: 409 });
    resolve(response({ data: [] }));
    await first;
  });
});

describe("action-bound business approvals", () => {
  it("reuses pending decisions, resumes once after approval and requires a new decision next time", async () => {
    install();
    grant("proxmox.inventory", true);
    const transport = vi.fn<typeof fetch>(async () => response({ data: [] }));
    adapters.set("proxmox", proxmox(transport));
    await service.refresh("proxmox", agentId, "ceo");
    const approvalId = source("proxmox").approvalId!;
    expect(source("proxmox").state).toBe("approval_required");
    await service.refresh("proxmox", agentId, "ceo");
    expect(source("proxmox").approvalId).toBe(approvalId);
    expect(company.approvals.listPending(companyId)).toHaveLength(1);
    expect(transport).not.toHaveBeenCalled();
    company.approvals.decide(approvalId, "approved", "ceo");
    await service.refresh("proxmox", agentId, "ceo");
    expect(source("proxmox").state).toBe("ok");
    expect(transport).toHaveBeenCalledTimes(1);
    await service.refresh("proxmox", agentId, "ceo");
    expect(source("proxmox").state).toBe("approval_required");
    expect(source("proxmox").approvalId).not.toBe(approvalId);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("rechecks disabled tools even after a matching approval was granted", async () => {
    install();
    grant("proxmox.inventory", true);
    const transport = vi.fn<typeof fetch>(async () => response({ data: [] }));
    adapters.set("proxmox", proxmox(transport));
    await service.refresh("proxmox", agentId, "ceo");
    company.approvals.decide(source("proxmox").approvalId!, "approved", "ceo");
    db.prepare("UPDATE crew_tools SET enabled=0 WHERE company_id=? AND key=?").run(companyId, "proxmox.inventory");
    await service.refresh("proxmox", agentId, "ceo");
    expect(source("proxmox").state).toBe("denied");
    expect(transport).not.toHaveBeenCalled();
  });
  it("does not accept another action's approval or expired binding", async () => {
    install();
    grant("proxmox.inventory", true);
    const transport = vi.fn<typeof fetch>(async () => response({ data: [] }));
    adapters.set("proxmox", proxmox(transport));
    const unrelated = company.approvals.request(companyId, {
      requestedBy: agentId,
      approvalType: "irreversible_data_change",
      summary: "Other action",
      proposedAction: "proxmox.inventory",
    });
    company.approvals.decide(unrelated.id, "approved", "ceo");
    await service.refresh("proxmox", agentId, "ceo");
    const bound = source("proxmox").approvalId!;
    expect(bound).not.toBe(unrelated.id);
    expect(transport).not.toHaveBeenCalled();
    company.approvals.decide(bound, "approved", "ceo");
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 16 * 60_000);
    try {
      await service.refresh("proxmox", agentId, "ceo");
      expect(source("proxmox").state).toBe("approval_required");
      expect(source("proxmox").approvalId).not.toBe(bound);
      expect(transport).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });
  it("resumes after service restart using persisted binding and records one consumption", async () => {
    install();
    grant("proxmox.inventory", true);
    const transport = vi.fn<typeof fetch>(async () => response({ data: [] }));
    adapters.set("proxmox", proxmox(transport));
    await service.refresh("proxmox", agentId, "ceo");
    const approvalId = source("proxmox").approvalId!;
    company.approvals.decide(approvalId, "approved", "ceo");
    const restarted = new BusinessDashboardService({
      db,
      companyId,
      getAdapter: (key) => adapters.get(key),
      gate: (agent, tool) => company.requestToolUse(companyId, agent, tool),
      agents: () => [{ id: agentId, displayName: "Atlas" }],
    });
    expect(restarted.snapshot().sources.find((source) => source.id === "proxmox")?.state).toBe("not_refreshed");
    await restarted.refresh("proxmox", agentId, "ceo");
    await service.refresh("proxmox", agentId, "ceo");
    expect(transport).toHaveBeenCalledTimes(1);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM crew_audit_events WHERE action='business.source.approval_consumed' AND approval_id=?",
        )
        .get(approvalId)?.n,
    ).toBe(1);
  });
  it("redacts recognizable credentials in external record names before caching", async () => {
    install();
    grant("proxmox.inventory");
    const secret = "sk-abcdefghijklmnopqrstuvwxyz1234567890";
    adapters.set(
      "proxmox",
      proxmox(async () => response({ data: [{ vmid: 1, type: "qemu", name: secret, status: "running" }] })),
    );
    await service.refresh("proxmox", agentId, "ceo");
    expect(source("proxmox").state).toBe("ok");
    expect(JSON.stringify(service.snapshot())).not.toContain(secret);
  });
});

it("does not lend a bound approval to another legitimate company agent", async () => {
  install();
  grant("proxmox.inventory", true);
  const transport = vi.fn<typeof fetch>(async () => response({ data: [] }));
  adapters.set("proxmox", proxmox(transport));
  await service.refresh("proxmox", agentId, "ceo");
  const approvalId = source("proxmox").approvalId!;
  company.approvals.decide(approvalId, "approved", "ceo");
  const other = company.listAgents(companyId).find((agent) => agent.id !== agentId)!;
  company.tools.grant({
    toolId: company.tools.byKey(companyId, "proxmox.inventory")!.id,
    agentId: other.id,
    requiresApproval: true,
  });
  await service.refresh("proxmox", other.id, "ceo");
  expect(source("proxmox").state).toBe("approval_required");
  expect(source("proxmox").approvalId).not.toBe(approvalId);
  expect(transport).not.toHaveBeenCalled();
});
