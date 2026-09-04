/**
 * The gate an agent passes through to reach a tool.
 *
 * `requestToolUse` deliberately answers "may I?" and "must someone approve
 * first?" in one call: a caller that could ask the first question and skip
 * the second is a caller for whom the gate does not exist, and the tools this
 * matters for are the ones that submit forms and spend money.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createTestDb } from "../domain/test-db.ts";
import { CompanyOrchestrator } from "./company.ts";
import { MockRuntime } from "../runtime/mock-runtime.ts";
import { configDir, loadCrewConfig, loadDepartmentConfig } from "../domain/crew-config.ts";
import { verifyAuditChain } from "../domain/audit.ts";
import type { SearchProvider, SearchResult } from "../search/search-provider.ts";
import { UNTRUSTED_OPEN } from "../policy/untrusted-content.ts";

let db: DatabaseSync;
let orc: CompanyOrchestrator;
let companyId: string;
let agentId: string;

const crew = loadCrewConfig(undefined, path.join(configDir(), "private", "__no_such_pack__.local.yaml"));
const departments = loadDepartmentConfig();

beforeEach(() => {
  db = createTestDb();
  orc = new CompanyOrchestrator(db);
  orc.registerRuntime(new MockRuntime());
  companyId = orc.seedCompany({ name: "IronCrew", slug: "iron", crew, departments });
  agentId = orc.listAgents(companyId).find((a) => !a.is_executive_assistant)!.id;
  orc.ensureBuiltinTools(companyId);
});

afterEach(() => db.close());

function talentOf(agent: string): string {
  return (db.prepare("SELECT talent_id FROM crew_agents WHERE id = ?").get(agent) as { talent_id: string }).talent_id;
}

function grant(key: string, over: Record<string, unknown> = {}) {
  const tool = orc.tools.byKey(companyId, key)!;
  return orc.tools.grant({ toolId: tool.id, agentId, ...over });
}

class StubSearch implements SearchProvider {
  readonly kind = "stub";
  constructor(private readonly results: SearchResult[] = []) {}
  async search(): Promise<SearchResult[]> {
    return this.results;
  }
  async testConnection() {
    return { ok: true, message: "" };
  }
}

describe("built-in tools", () => {
  it("registers the four this server can actually perform", () => {
    expect(orc.tools.list(companyId).map((t) => t.key).sort()).toEqual([
      "browser.external",
      "browser.interact",
      "browser.read",
      "web.search",
    ]);
  });

  it("grants nothing by registering", () => {
    // Presence is not permission — the same posture as mailboxes and pairings.
    expect(orc.requestToolUse(companyId, agentId, "web.search")).toEqual({ outcome: "denied" });
  });

  it("does not switch a disabled tool back on at the next boot", () => {
    const tool = orc.tools.byKey(companyId, "web.search")!;
    orc.tools.setEnabled(tool.id, false);

    orc.ensureBuiltinTools(companyId);
    expect(orc.tools.byKey(companyId, "web.search")!.enabled).toBe(0);
  });
});

describe("requestToolUse", () => {
  it("allows a granted read tool without an approval", () => {
    grant("web.search");
    expect(orc.requestToolUse(companyId, agentId, "web.search")).toEqual({ outcome: "allowed" });
    expect(orc.approvals.listPending(companyId)).toHaveLength(0);
  });

  it("raises an approval for an external tool and does not allow it yet", () => {
    grant("browser.external");
    const result = orc.requestToolUse(companyId, agentId, "browser.external", { summary: "Formular absenden" });

    expect(result.outcome).toBe("approval_required");
    expect(orc.approvals.listPending(companyId)).toHaveLength(1);
  });

  it("records a denial in the audit log, so an operator can see what was refused", () => {
    orc.requestToolUse(companyId, agentId, "browser.external");

    const denied = db
      .prepare("SELECT action, outcome, details_json FROM crew_audit_events WHERE action = 'tool.denied'")
      .get() as { outcome: string; details_json: string } | undefined;
    expect(denied?.outcome).toBe("denied");
    expect(denied?.details_json).toContain("no_grant");
  });

  it("records a use, so the log shows what a run actually reached for", () => {
    grant("web.search");
    orc.requestToolUse(companyId, agentId, "web.search");
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM crew_audit_events WHERE action = 'tool.used'").get(),
    ).toEqual({ n: 1 });
  });

  it("honours the project scope", () => {
    const tool = orc.tools.byKey(companyId, "web.search")!;
    const projectId = orc.projects.create({ companyId, key: "kunde", title: "Kundenprojekt" }).id;
    orc.tools.grant({ toolId: tool.id, projectId });

    expect(orc.requestToolUse(companyId, agentId, "web.search")).toEqual({ outcome: "denied" });
    expect(orc.requestToolUse(companyId, agentId, "web.search", { projectId })).toEqual({ outcome: "allowed" });
  });

  it("keeps the audit chain intact", () => {
    grant("web.search");
    orc.requestToolUse(companyId, agentId, "web.search");
    orc.requestToolUse(companyId, agentId, "browser.external");
    expect(verifyAuditChain(db, companyId).valid).toBe(true);
  });
});

describe("MCP servers become tools behind the same gate", () => {
  it("registers one tool per configured server, as external", () => {
    const result = orc.syncMcpTools(companyId, ["jira", "github"]);
    expect(result.added).toBe(2);
    expect(orc.tools.byKey(companyId, "mcp.jira")!.risk_class).toBe("external");
    expect(orc.tools.byKey(companyId, "mcp.jira")!.origin).toBe("mcp");
  });

  it("is idempotent across restarts", () => {
    orc.syncMcpTools(companyId, ["jira"]);
    expect(orc.syncMcpTools(companyId, ["jira"])).toEqual({ added: 0, disabled: 0 });
  });

  it("disables a server that vanished rather than deleting it", () => {
    orc.syncMcpTools(companyId, ["jira"]);
    const tool = orc.tools.byKey(companyId, "mcp.jira")!;
    orc.tools.grant({ toolId: tool.id, agentId });

    const result = orc.syncMcpTools(companyId, []);
    expect(result.disabled).toBe(1);
    expect(orc.tools.byKey(companyId, "mcp.jira")!.enabled).toBe(0);
    // Deleting would drop the grant silently, and re-adding the server would
    // come back with its access wiped and nobody would know why.
    expect(orc.tools.grantsFor(tool.id)).toHaveLength(1);
  });

  it("leaves a re-added server usable again", () => {
    orc.syncMcpTools(companyId, ["jira"]);
    const tool = orc.tools.byKey(companyId, "mcp.jira")!;
    orc.tools.grant({ toolId: tool.id, agentId, requiresApproval: false, allowUnapprovedExternal: true });
    orc.syncMcpTools(companyId, []);
    expect(orc.requestToolUse(companyId, agentId, "mcp.jira")).toEqual({ outcome: "denied" });

    orc.tools.setEnabled(tool.id, true);
    expect(orc.requestToolUse(companyId, agentId, "mcp.jira")).toEqual({ outcome: "allowed" });
  });

  it("does not touch built-in tools when syncing", () => {
    orc.syncMcpTools(companyId, []);
    expect(orc.tools.byKey(companyId, "web.search")!.enabled).toBe(1);
  });
});

describe("searchWeb goes through the gate", () => {
  const results: SearchResult[] = [
    { title: "Treffer", url: "https://example.com/a", snippet: "Inhalt", rank: 1, publishedAt: null },
  ];

  it("refuses when the agent has no grant", async () => {
    orc.registerSearchProvider(new StubSearch(results));
    // A caller that could search without asking is a caller for whom the gate
    // does not exist.
    expect(await orc.searchWeb(companyId, agentId, { query: "x" })).toEqual({ outcome: "denied" });
  });

  it("returns results and a fenced block once granted", async () => {
    orc.registerSearchProvider(new StubSearch(results));
    grant("web.search");

    const result = await orc.searchWeb(companyId, agentId, { query: "deployment" });
    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") return;
    expect(result.results).toHaveLength(1);
    // The only form that may reach a prompt: these sentences were written by
    // strangers.
    expect(result.prompt).toContain(UNTRUSTED_OPEN);
    expect(result.prompt).toContain("https://example.com/a");
  });

  it("asks for approval first when an operator gated the search", async () => {
    orc.registerSearchProvider(new StubSearch(results));
    grant("web.search", { requiresApproval: true });

    const result = await orc.searchWeb(companyId, agentId, { query: "x" });
    expect(result.outcome).toBe("approval_required");
  });

  it("throws when no provider is configured, rather than pretending", async () => {
    grant("web.search");
    await expect(orc.searchWeb(companyId, agentId, { query: "x" })).rejects.toThrow(/Suchanbieter/);
  });

  it("reports provider reachability without throwing", async () => {
    expect(await orc.testSearchProvider("stub")).toMatchObject({ ok: false });
    orc.registerSearchProvider(new StubSearch());
    expect(await orc.testSearchProvider("stub")).toMatchObject({ ok: true });
    expect(orc.listSearchProviderKinds()).toEqual(["stub"]);
  });

  it("works through a talent grant, so a role keeps its search", async () => {
    orc.registerSearchProvider(new StubSearch(results));
    const tool = orc.tools.byKey(companyId, "web.search")!;
    orc.tools.grant({ toolId: tool.id, talentId: talentOf(agentId) });

    expect((await orc.searchWeb(companyId, agentId, { query: "x" })).outcome).toBe("ok");
  });
});
