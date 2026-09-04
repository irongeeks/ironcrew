/**
 * IronCrew — what an agent may reach for.
 *
 * The company could already say which model an agent runs on, how long it may
 * run, and whether an act needs approval. What it could not say is the thing
 * an operator actually worries about: this agent may search the web, that one
 * may not touch a browser, and nobody publishes anything without being asked.
 *
 * Until now a tool was either compiled in or installed from a marketplace,
 * and once present it was available to every agent. That is the same shape
 * the mailbox grants and the messenger pairings already rejected — presence
 * is not permission — so tools get the same treatment: a registry of what
 * exists, and explicit grants for who may use it.
 *
 * THE ONE FUNCTION THAT MATTERS
 *
 * `resolve()` is the gate. Everything else here exists to make its answer
 * correct. It fails closed at every step: an unknown tool, a disabled tool, a
 * missing grant and an unknown agent all return "denied", and the caller
 * cannot tell them apart in a way that would let it proceed. There is no
 * "allow if we could not decide".
 *
 * A grant may attach to an **agent** or to a **talent**. A talent grant
 * follows the role wherever it is paired, so "every CTO may search the web"
 * survives an agent being rebuilt into a different vessel; an agent grant is
 * for this one post. When both exist, the agent grant wins — it is the more
 * specific statement, and an operator who wrote it meant this agent.
 *
 * APPROVAL IS RESOLVED, NOT ASSUMED
 *
 * `requires_approval` is nullable on the grant precisely so that omitting it
 * means "whatever the tool's risk class implies" rather than "no". An
 * `external` tool — one whose use causes something outside to treat the act
 * as real — requires approval unless a grant explicitly says otherwise, and
 * `grant()` refuses to write that waiver unless the caller passes
 * `allowUnapprovedExternal`. Turning off the gate on a tool that can submit a
 * form or spend money should take more than forgetting a field.
 */

import type { DatabaseSync } from "node:sqlite";
import { newId } from "./ids.ts";
import { allRows, oneRow } from "./sql.ts";
import { appendAuditEvent, type ActorType } from "./audit.ts";

export const TOOL_RISK_CLASSES = ["read", "write", "external"] as const;
export type ToolRiskClass = (typeof TOOL_RISK_CLASSES)[number];

export const TOOL_ORIGINS = ["builtin", "mcp", "marketplace", "pack"] as const;
export type ToolOrigin = (typeof TOOL_ORIGINS)[number];

export interface ToolRow {
  id: string;
  company_id: string;
  key: string;
  label: string;
  description: string;
  risk_class: ToolRiskClass;
  origin: string;
  enabled: number;
  created_at: number;
  updated_at: number;
}

export interface ToolGrantRow {
  id: string;
  tool_id: string;
  agent_id: string | null;
  talent_id: string | null;
  project_id: string | null;
  requires_approval: number | null;
  granted_by: string;
  created_at: number;
}

export class ToolMutationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolMutationError";
  }
}

/**
 * What `resolve()` answers.
 *
 * `allowed: false` carries a reason for the operator's benefit, never for the
 * caller's: no reason unlocks anything.
 */
export type ToolDecision =
  | { allowed: true; tool: ToolRow; requiresApproval: boolean; via: "agent" | "project" | "talent" }
  | { allowed: false; reason: "unknown_tool" | "disabled" | "no_grant" | "unknown_agent" };

const TOOL_COLUMNS = `id, company_id, key, label, description, risk_class, origin, enabled, created_at, updated_at`;
const GRANT_COLUMNS = `id, tool_id, agent_id, talent_id, project_id, requires_approval, granted_by, created_at`;

/** Risk classes that need an approval unless a grant deliberately waives it. */
function defaultRequiresApproval(risk: ToolRiskClass): boolean {
  return risk === "external";
}

export class ToolStore {
  constructor(private readonly db: DatabaseSync) {}

  register(
    input: {
      companyId: string;
      key: string;
      label?: string;
      description?: string;
      riskClass?: ToolRiskClass;
      origin?: ToolOrigin | string;
      enabled?: boolean;
    },
    opts: { actorType?: ActorType; actorId?: string } = {},
  ): ToolRow {
    const key = input.key.trim();
    if (!key) throw new ToolMutationError("Ein Werkzeug braucht einen Schlüssel.");
    if (this.byKey(input.companyId, key)) {
      throw new ToolMutationError(`Es gibt bereits ein Werkzeug mit dem Schlüssel "${key}".`);
    }

    const id = newId("tool");
    this.db
      .prepare(
        `INSERT INTO crew_tools (id, company_id, key, label, description, risk_class, origin, enabled)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.companyId,
        key,
        input.label ?? key,
        input.description ?? "",
        input.riskClass ?? "read",
        input.origin ?? "builtin",
        input.enabled === false ? 0 : 1,
      );

    appendAuditEvent(this.db, {
      companyId: input.companyId,
      actorType: opts.actorType ?? "owner",
      actorId: opts.actorId ?? "ceo",
      action: "tool.registered",
      entityType: "tool",
      entityId: id,
      details: { key, riskClass: input.riskClass ?? "read", origin: input.origin ?? "builtin" },
    });
    return this.get(id)!;
  }

  /**
   * Registers a tool if its key is new, leaves it alone otherwise.
   *
   * Used at boot for the built-in tools. Re-registering on every start must
   * not overwrite an operator's decisions — in particular not `enabled`,
   * which is how a tool gets switched off company-wide.
   */
  ensure(input: Parameters<ToolStore["register"]>[0], opts: { actorType?: ActorType; actorId?: string } = {}): ToolRow {
    return this.byKey(input.companyId, input.key.trim()) ?? this.register(input, opts);
  }

  get(id: string): ToolRow | null {
    return oneRow<ToolRow>(this.db.prepare(`SELECT ${TOOL_COLUMNS} FROM crew_tools WHERE id = ?`), id);
  }

  byKey(companyId: string, key: string): ToolRow | null {
    return oneRow<ToolRow>(
      this.db.prepare(`SELECT ${TOOL_COLUMNS} FROM crew_tools WHERE company_id = ? AND key = ?`),
      companyId,
      key,
    );
  }

  list(companyId: string): ToolRow[] {
    return allRows<ToolRow>(
      this.db.prepare(`SELECT ${TOOL_COLUMNS} FROM crew_tools WHERE company_id = ? ORDER BY risk_class, key`),
      companyId,
    );
  }

  /** Switches a tool off for everyone, without touching the grants. */
  setEnabled(id: string, enabled: boolean, opts: { actorType?: ActorType; actorId?: string } = {}): ToolRow | null {
    const tool = this.get(id);
    if (!tool) return null;

    this.db
      .prepare("UPDATE crew_tools SET enabled = ?, updated_at = ? WHERE id = ?")
      .run(enabled ? 1 : 0, Date.now(), id);

    appendAuditEvent(this.db, {
      companyId: tool.company_id,
      actorType: opts.actorType ?? "owner",
      actorId: opts.actorId ?? "ceo",
      action: enabled ? "tool.enabled" : "tool.disabled",
      entityType: "tool",
      entityId: id,
      details: { key: tool.key },
    });
    return this.get(id);
  }

  /**
   * Grants a tool to one agent or one talent.
   *
   * `requiresApproval: false` on an `external` tool is refused unless the
   * caller passes `allowUnapprovedExternal` — see this module's header. The
   * flag exists so that waiving the gate is a sentence someone wrote, not a
   * field someone forgot.
   */
  grant(
    input: {
      toolId: string;
      agentId?: string | null;
      talentId?: string | null;
      projectId?: string | null;
      requiresApproval?: boolean | null;
      allowUnapprovedExternal?: boolean;
    },
    opts: { actorType?: ActorType; actorId?: string } = {},
  ): ToolGrantRow {
    const tool = this.get(input.toolId);
    if (!tool) throw new ToolMutationError(`Werkzeug "${input.toolId}" existiert nicht.`);

    const agentId = input.agentId ?? null;
    const talentId = input.talentId ?? null;
    const projectId = input.projectId ?? null;
    const named = [agentId, talentId, projectId].filter((v) => v !== null).length;
    if (named !== 1) {
      throw new ToolMutationError(
        "Eine Freigabe gilt genau einem Agenten, einem Talent oder einem Projekt — nicht mehreren und nicht keinem.",
      );
    }

    if (
      input.requiresApproval === false &&
      defaultRequiresApproval(tool.risk_class) &&
      !input.allowUnapprovedExternal
    ) {
      throw new ToolMutationError(
        `"${tool.key}" wirkt nach außen. Die Freigabepflicht lässt sich nur bewusst abschalten.`,
      );
    }

    const scopeColumn = agentId ? "agent_id" : projectId ? "project_id" : "talent_id";
    const scopeId = agentId ?? projectId ?? talentId;
    const existing = oneRow<ToolGrantRow>(
      this.db.prepare(`SELECT ${GRANT_COLUMNS} FROM crew_tool_grants WHERE tool_id = ? AND ${scopeColumn} = ?`),
      input.toolId,
      scopeId,
    );

    const requiresApproval =
      input.requiresApproval === undefined || input.requiresApproval === null ? null : input.requiresApproval ? 1 : 0;

    if (existing) {
      this.db
        .prepare("UPDATE crew_tool_grants SET requires_approval = ?, granted_by = ? WHERE id = ?")
        .run(requiresApproval, opts.actorId ?? "ceo", existing.id);
      this.auditGrant(tool, existing.id, agentId, talentId, projectId, "tool.grant_updated", opts);
      return this.grantById(existing.id)!;
    }

    const id = newId("tgrant");
    this.db
      .prepare(
        `INSERT INTO crew_tool_grants (id, tool_id, agent_id, talent_id, project_id, requires_approval, granted_by)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(id, input.toolId, agentId, talentId, projectId, requiresApproval, opts.actorId ?? "ceo");

    this.auditGrant(tool, id, agentId, talentId, projectId, "tool.granted", opts);
    return this.grantById(id)!;
  }

  private auditGrant(
    tool: ToolRow,
    grantId: string,
    agentId: string | null,
    talentId: string | null,
    projectId: string | null,
    action: string,
    opts: { actorType?: ActorType; actorId?: string },
  ): void {
    appendAuditEvent(this.db, {
      companyId: tool.company_id,
      actorType: opts.actorType ?? "owner",
      actorId: opts.actorId ?? "ceo",
      action,
      entityType: "tool_grant",
      entityId: grantId,
      details: { toolKey: tool.key, riskClass: tool.risk_class, agentId, talentId, projectId },
    });
  }

  grantById(id: string): ToolGrantRow | null {
    return oneRow<ToolGrantRow>(this.db.prepare(`SELECT ${GRANT_COLUMNS} FROM crew_tool_grants WHERE id = ?`), id);
  }

  grantsFor(toolId: string): ToolGrantRow[] {
    return allRows<ToolGrantRow>(
      this.db.prepare(`SELECT ${GRANT_COLUMNS} FROM crew_tool_grants WHERE tool_id = ? ORDER BY created_at`),
      toolId,
    );
  }

  revoke(grantId: string, opts: { actorType?: ActorType; actorId?: string } = {}): boolean {
    const grant = this.grantById(grantId);
    if (!grant) return false;
    const tool = this.get(grant.tool_id);

    this.db.prepare("DELETE FROM crew_tool_grants WHERE id = ?").run(grantId);
    if (tool) {
      this.auditGrant(tool, grantId, grant.agent_id, grant.talent_id, grant.project_id, "tool.revoked", opts);
    }
    return true;
  }

  /**
   * The gate: may this agent use this tool, and does each use need approval?
   *
   * Fails closed at every step. An agent grant beats a talent grant because
   * it is the more specific statement about this particular post.
   */
  resolve(
    companyId: string,
    agentId: string,
    toolKey: string,
    context: { projectId?: string | null } = {},
  ): ToolDecision {
    const tool = this.byKey(companyId, toolKey);
    if (!tool) return { allowed: false, reason: "unknown_tool" };
    if (tool.enabled !== 1) return { allowed: false, reason: "disabled" };

    const agent = this.db
      .prepare("SELECT id, talent_id FROM crew_agents WHERE id = ? AND company_id = ?")
      .get(agentId, companyId) as { id: string; talent_id: string | null } | undefined;
    if (!agent) return { allowed: false, reason: "unknown_agent" };

    const byScope = (column: "agent_id" | "talent_id" | "project_id", value: string | null): ToolGrantRow | null =>
      value === null
        ? null
        : oneRow<ToolGrantRow>(
            this.db.prepare(`SELECT ${GRANT_COLUMNS} FROM crew_tool_grants WHERE tool_id = ? AND ${column} = ?`),
            tool.id,
            value,
          );

    // Most specific first: this post, then this context, then the role in
    // general. The precedence is written down once, in migration 0019's
    // header; this is the code that follows it.
    const candidates: Array<{ via: "agent" | "project" | "talent"; grant: ToolGrantRow | null }> = [
      { via: "agent", grant: byScope("agent_id", agent.id) },
      { via: "project", grant: byScope("project_id", context.projectId ?? null) },
      { via: "talent", grant: byScope("talent_id", agent.talent_id) },
    ];

    const match = candidates.find((c) => c.grant !== null);
    if (!match?.grant) return { allowed: false, reason: "no_grant" };

    return {
      allowed: true,
      tool,
      // NULL means "whatever the risk class implies", which is what keeps an
      // external tool gated by omission rather than by remembering.
      requiresApproval:
        match.grant.requires_approval === null
          ? defaultRequiresApproval(tool.risk_class)
          : match.grant.requires_approval === 1,
      via: match.via,
    };
  }

  /** Every tool this agent may use, for showing an operator what a post can do. */
  listForAgent(
    companyId: string,
    agentId: string,
    context: { projectId?: string | null } = {},
  ): Array<{ tool: ToolRow; requiresApproval: boolean; via: string }> {
    return this.list(companyId)
      .map((tool) => ({ tool, decision: this.resolve(companyId, agentId, tool.key, context) }))
      .filter(
        (row): row is { tool: ToolRow; decision: Extract<ToolDecision, { allowed: true }> } => row.decision.allowed,
      )
      .map(({ tool, decision }) => ({ tool, requiresApproval: decision.requiresApproval, via: decision.via }));
  }
}
