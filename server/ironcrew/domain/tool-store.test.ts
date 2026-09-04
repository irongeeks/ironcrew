import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createTestDb, seedAgent, seedCompany } from "./test-db.ts";
import { ToolMutationError, ToolStore } from "./tool-store.ts";
import { newId } from "./ids.ts";
import { verifyAuditChain } from "./audit.ts";

let db: DatabaseSync;
let companyId: string;
let agentId: string;
let tools: ToolStore;

beforeEach(() => {
  db = createTestDb();
  companyId = seedCompany(db);
  agentId = seedAgent(db, companyId);
  tools = new ToolStore(db);
});

afterEach(() => db.close());

function talentOf(agent: string): string {
  return (db.prepare("SELECT talent_id FROM crew_agents WHERE id = ?").get(agent) as { talent_id: string }).talent_id;
}

function register(over: Record<string, unknown> = {}) {
  return tools.register({ companyId, key: "web.search", riskClass: "read", ...over });
}

describe("the registry", () => {
  it("registers a tool with its risk class", () => {
    const tool = register({ key: "browser.navigate", riskClass: "external", label: "Browser" });
    expect(tool.risk_class).toBe("external");
    expect(tool.enabled).toBe(1);
  });

  it("refuses a duplicate key", () => {
    register();
    expect(() => register()).toThrow(ToolMutationError);
  });

  it("refuses a tool without a key", () => {
    expect(() => register({ key: "   " })).toThrow(/Schlüssel/);
  });

  it("ensure() does not overwrite an operator's decision on a restart", () => {
    const tool = register();
    tools.setEnabled(tool.id, false);

    // Boot registers the built-ins again; a tool switched off company-wide
    // must stay off.
    const again = tools.ensure({ companyId, key: "web.search", riskClass: "read" });
    expect(again.id).toBe(tool.id);
    expect(again.enabled).toBe(0);
  });
});

describe("resolve: the gate", () => {
  it("denies a tool nobody granted", () => {
    register();
    expect(tools.resolve(companyId, agentId, "web.search")).toEqual({ allowed: false, reason: "no_grant" });
  });

  it("denies a tool that does not exist", () => {
    expect(tools.resolve(companyId, agentId, "erfunden")).toEqual({ allowed: false, reason: "unknown_tool" });
  });

  it("denies an unknown agent even when the tool is granted broadly", () => {
    const tool = register();
    tools.grant({ toolId: tool.id, talentId: talentOf(agentId) });
    expect(tools.resolve(companyId, "agt_nope", "web.search")).toEqual({ allowed: false, reason: "unknown_agent" });
  });

  it("denies an agent from another company", () => {
    const other = seedCompany(db, "Andere GmbH");
    const otherAgent = seedAgent(db, other, "cto");
    const tool = register();
    tools.grant({ toolId: tool.id, agentId });

    // The grant exists, but not in this company — a tool id is unique
    // database-wide, so the company has to be checked here.
    expect(tools.resolve(companyId, otherAgent, "web.search").allowed).toBe(false);
  });

  it("denies a tool switched off company-wide, grant or no grant", () => {
    const tool = register();
    tools.grant({ toolId: tool.id, agentId });
    tools.setEnabled(tool.id, false);

    expect(tools.resolve(companyId, agentId, "web.search")).toEqual({ allowed: false, reason: "disabled" });
  });

  it("allows an agent that was granted it directly", () => {
    const tool = register();
    tools.grant({ toolId: tool.id, agentId });

    const decision = tools.resolve(companyId, agentId, "web.search");
    expect(decision.allowed).toBe(true);
    expect(decision.allowed && decision.via).toBe("agent");
  });

  it("allows an agent through its talent, so a role keeps its tools", () => {
    const tool = register();
    tools.grant({ toolId: tool.id, talentId: talentOf(agentId) });

    const decision = tools.resolve(companyId, agentId, "web.search");
    expect(decision.allowed).toBe(true);
    expect(decision.allowed && decision.via).toBe("talent");
  });

  it("lets the agent grant win over the talent grant", () => {
    const tool = register({ riskClass: "external" });
    tools.grant({ toolId: tool.id, talentId: talentOf(agentId), requiresApproval: true });
    tools.grant({ toolId: tool.id, agentId, requiresApproval: false, allowUnapprovedExternal: true });

    const decision = tools.resolve(companyId, agentId, "web.search");
    // The more specific statement about this post is the one an operator meant.
    expect(decision.allowed && decision.via).toBe("agent");
    expect(decision.allowed && decision.requiresApproval).toBe(false);
  });
});

describe("approval follows the risk class unless someone says otherwise", () => {
  it("gates an external tool by default", () => {
    const tool = register({ key: "browser.submit", riskClass: "external" });
    tools.grant({ toolId: tool.id, agentId });

    const decision = tools.resolve(companyId, agentId, "browser.submit");
    // Omitting the field must mean "gated", not "open".
    expect(decision.allowed && decision.requiresApproval).toBe(true);
  });

  it("does not gate a read tool by default", () => {
    const tool = register();
    tools.grant({ toolId: tool.id, agentId });
    expect(tools.resolve(companyId, agentId, "web.search")).toMatchObject({ requiresApproval: false });
  });

  it("refuses to waive the gate on an external tool by accident", () => {
    const tool = register({ key: "browser.submit", riskClass: "external" });

    expect(() => tools.grant({ toolId: tool.id, agentId, requiresApproval: false })).toThrow(/bewusst/);
    // And nothing was written.
    expect(tools.grantsFor(tool.id)).toHaveLength(0);
  });

  it("allows the waiver when it is deliberate", () => {
    const tool = register({ key: "browser.submit", riskClass: "external" });
    tools.grant({ toolId: tool.id, agentId, requiresApproval: false, allowUnapprovedExternal: true });
    expect(tools.resolve(companyId, agentId, "browser.submit")).toMatchObject({ requiresApproval: false });
  });

  it("can gate a read tool when an operator wants it gated", () => {
    const tool = register();
    tools.grant({ toolId: tool.id, agentId, requiresApproval: true });
    expect(tools.resolve(companyId, agentId, "web.search")).toMatchObject({ requiresApproval: true });
  });
});

describe("grants", () => {
  it("refuses a grant naming both an agent and a talent, or neither", () => {
    const tool = register();
    expect(() => tools.grant({ toolId: tool.id, agentId, talentId: talentOf(agentId) })).toThrow(ToolMutationError);
    expect(() => tools.grant({ toolId: tool.id })).toThrow(ToolMutationError);
  });

  it("refuses a grant for a tool that does not exist", () => {
    expect(() => tools.grant({ toolId: "tool_nope", agentId })).toThrow(/existiert nicht/);
  });

  it("updates rather than duplicating when granted twice", () => {
    const tool = register();
    tools.grant({ toolId: tool.id, agentId });
    tools.grant({ toolId: tool.id, agentId, requiresApproval: true });

    expect(tools.grantsFor(tool.id)).toHaveLength(1);
    expect(tools.resolve(companyId, agentId, "web.search")).toMatchObject({ requiresApproval: true });
  });

  it("revokes, and the agent loses the tool", () => {
    const tool = register();
    const grant = tools.grant({ toolId: tool.id, agentId });
    expect(tools.revoke(grant.id)).toBe(true);

    expect(tools.resolve(companyId, agentId, "web.search")).toEqual({ allowed: false, reason: "no_grant" });
    expect(tools.revoke(grant.id)).toBe(false);
  });

  it("takes the grants with it when the tool goes", () => {
    const tool = register();
    tools.grant({ toolId: tool.id, agentId });
    db.prepare("DELETE FROM crew_tools WHERE id = ?").run(tool.id);
    expect(tools.grantsFor(tool.id)).toHaveLength(0);
  });

  it("lists what one agent may do", () => {
    const search = register();
    const browser = register({ key: "browser.submit", riskClass: "external" });
    register({ key: "files.write", riskClass: "write" });
    tools.grant({ toolId: search.id, agentId });
    tools.grant({ toolId: browser.id, talentId: talentOf(agentId) });

    const listed = tools.listForAgent(companyId, agentId);
    expect(listed.map((r) => r.tool.key).sort()).toEqual(["browser.submit", "web.search"]);
    expect(listed.find((r) => r.tool.key === "browser.submit")!.requiresApproval).toBe(true);
  });
});

it("audits the lifecycle and keeps the chain valid", () => {
  const tool = register({ key: "browser.submit", riskClass: "external" });
  const grant = tools.grant({ toolId: tool.id, agentId });
  tools.revoke(grant.id);
  tools.setEnabled(tool.id, false);

  const actions = (
    db.prepare("SELECT action FROM crew_audit_events WHERE company_id = ? ORDER BY seq").all(companyId) as Array<{
      action: string;
    }>
  ).map((r) => r.action);

  expect(actions).toEqual(expect.arrayContaining(["tool.registered", "tool.granted", "tool.revoked", "tool.disabled"]));
  expect(verifyAuditChain(db, companyId).valid).toBe(true);
});

describe("project scope: a tool that belongs to one customer's project", () => {
  let projectSeq = 0;
  function project(title = "Kundenprojekt"): string {
    const id = newId("prj");
    db.prepare("INSERT INTO crew_projects (id, company_id, key, title) VALUES (?,?,?,?)").run(
      id,
      companyId,
      `p${projectSeq++}`,
      title,
    );
    return id;
  }

  it("allows an agent working inside that project", () => {
    const tool = register({ key: "mcp.jira", origin: "mcp" });
    const projectId = project();
    tools.grant({ toolId: tool.id, projectId });

    const decision = tools.resolve(companyId, agentId, "mcp.jira", { projectId });
    expect(decision.allowed).toBe(true);
    expect(decision.allowed && decision.via).toBe("project");
  });

  it("denies the same agent outside that project", () => {
    const tool = register({ key: "mcp.jira", origin: "mcp" });
    const projectId = project();
    tools.grant({ toolId: tool.id, projectId });

    // The whole point for an MSP: the technician has the customer's tools
    // inside the customer's project and nowhere else.
    expect(tools.resolve(companyId, agentId, "mcp.jira")).toEqual({ allowed: false, reason: "no_grant" });
    expect(tools.resolve(companyId, agentId, "mcp.jira", { projectId: project("Anderes") })).toEqual({
      allowed: false,
      reason: "no_grant",
    });
  });

  it("follows the precedence agent > project > talent", () => {
    const tool = register({ key: "mcp.jira", riskClass: "external", origin: "mcp" });
    const projectId = project();
    tools.grant({ toolId: tool.id, talentId: talentOf(agentId), requiresApproval: true });
    tools.grant({ toolId: tool.id, projectId, requiresApproval: false, allowUnapprovedExternal: true });

    // Project beats talent: a statement about this context beats a standing
    // statement about the role.
    expect(tools.resolve(companyId, agentId, "mcp.jira", { projectId })).toMatchObject({
      via: "project",
      requiresApproval: false,
    });

    tools.grant({ toolId: tool.id, agentId, requiresApproval: true });
    // And an agent grant beats both.
    expect(tools.resolve(companyId, agentId, "mcp.jira", { projectId })).toMatchObject({
      via: "agent",
      requiresApproval: true,
    });
  });

  it("falls back to the talent grant outside the project", () => {
    const tool = register({ key: "mcp.jira", origin: "mcp" });
    tools.grant({ toolId: tool.id, talentId: talentOf(agentId) });
    tools.grant({ toolId: tool.id, projectId: project() });

    expect(tools.resolve(companyId, agentId, "mcp.jira")).toMatchObject({ via: "talent" });
  });

  it("refuses a grant naming more than one scope", () => {
    const tool = register();
    const projectId = project();
    expect(() => tools.grant({ toolId: tool.id, agentId, projectId })).toThrow(ToolMutationError);
    expect(() => tools.grant({ toolId: tool.id, talentId: talentOf(agentId), projectId })).toThrow(ToolMutationError);
  });

  it("updates rather than duplicating a project grant", () => {
    const tool = register({ key: "mcp.jira", origin: "mcp" });
    const projectId = project();
    tools.grant({ toolId: tool.id, projectId });
    tools.grant({ toolId: tool.id, projectId, requiresApproval: true });

    expect(tools.grantsFor(tool.id)).toHaveLength(1);
    expect(tools.resolve(companyId, agentId, "mcp.jira", { projectId })).toMatchObject({ requiresApproval: true });
  });

  it("takes the grant with it when the project is deleted", () => {
    const tool = register({ key: "mcp.jira", origin: "mcp" });
    const projectId = project();
    tools.grant({ toolId: tool.id, projectId });

    db.prepare("DELETE FROM crew_projects WHERE id = ?").run(projectId);
    expect(tools.grantsFor(tool.id)).toHaveLength(0);
  });

  it("lists a project's tools for that context only", () => {
    const scoped = register({ key: "mcp.jira", origin: "mcp" });
    const always = register({ key: "web.search" });
    const projectId = project();
    tools.grant({ toolId: scoped.id, projectId });
    tools.grant({ toolId: always.id, talentId: talentOf(agentId) });

    expect(tools.listForAgent(companyId, agentId).map((r) => r.tool.key)).toEqual(["web.search"]);
    expect(
      tools
        .listForAgent(companyId, agentId, { projectId })
        .map((r) => r.tool.key)
        .sort(),
    ).toEqual(["mcp.jira", "web.search"]);
  });
});
