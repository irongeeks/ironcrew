import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  BusinessSource,
  BusinessMetric,
  BusinessRecord,
  BusinessDashboardSnapshot,
} from "../../../src/shared/business-dashboard.ts";
import { appendAuditEvent } from "../domain/audit.ts";
import { ToolStore } from "../domain/tool-store.ts";
import type { ApprovalRow } from "../policy/approval-policy.ts";
import { redact } from "../security/redaction.ts";
import { PackStore } from "./pack-store.ts";
import type { PackIntegrationAdapter } from "./pack-integration.ts";
import { ProxmoxAdapter } from "./integrations/proxmox.ts";
import { TacticalRmmAdapter } from "./integrations/tactical-rmm.ts";
import { UnifiAdapter } from "./integrations/unifi.ts";
import { SevdeskAdapter } from "./integrations/sevdesk.ts";
import { LexwareOfficeAdapter } from "./integrations/lexware-office.ts";

const DEFINITIONS = [
  {
    id: "proxmox",
    label: "Proxmox · Gäste",
    packKey: "msp",
    integration: "proxmox",
    toolKey: "proxmox.inventory",
    endpoint: "GET /api2/json/cluster/resources?type=vm",
  },
  {
    id: "rmm-agents",
    label: "Tactical RMM · Endpunkte",
    packKey: "msp",
    integration: "tactical-rmm",
    toolKey: "rmm.agents",
    endpoint: "GET /agents/?detail=true",
  },
  {
    id: "rmm-alerts",
    label: "Tactical RMM · offene Alarme",
    packKey: "msp",
    integration: "tactical-rmm",
    toolKey: "rmm.alerts",
    endpoint: "PATCH /alerts/ (lesender Filter)",
  },
  {
    id: "unifi",
    label: "UniFi · Geräte",
    packKey: "msp",
    integration: "unifi",
    toolKey: "unifi.devices",
    endpoint: "GET /integration/v1/sites/{site}/devices · erste Seite",
  },
  {
    id: "sevdesk",
    label: "sevDesk · offene Rechnungen",
    packKey: "finance-de",
    integration: "sevdesk",
    toolKey: "sevdesk.invoice",
    endpoint: "GET /Invoice?status=200&limit=100&countAll=true",
  },
  {
    id: "lexware",
    label: "Lexware Office · offene Rechnungen",
    packKey: "finance-de",
    integration: "lexware-office",
    toolKey: "lexware.vouchers",
    endpoint: "GET /v1/voucherlist?voucherType=invoice&voucherStatus=open · erste Seite",
  },
] satisfies Pick<BusinessSource, "id" | "label" | "packKey" | "integration" | "toolKey" | "endpoint">[];

type GateResult = { outcome: "allowed" | "denied" } | { outcome: "approval_required"; approvalId: string };
export interface BusinessDashboardOptions {
  db: DatabaseSync;
  companyId: string;
  getAdapter: (key: string) => PackIntegrationAdapter | undefined;
  gate: (agentId: string, toolKey: string) => GateResult;
  agents: () => { id: string; displayName: string }[];
}
export class BusinessDashboardError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** In-memory observations are deliberately not operational state. Restart makes freshness unknown. */
export class BusinessDashboardService {
  private readonly cache = new Map<string, BusinessSource>();
  private readonly refreshing = new Set<string>();
  private readonly packs: PackStore;
  constructor(private readonly options: BusinessDashboardOptions) {
    this.packs = new PackStore(options.db);
  }
  snapshot(): BusinessDashboardSnapshot {
    return { sources: DEFINITIONS.map((definition) => this.source(definition.id)), agents: this.options.agents() };
  }
  private source(id: string): BusinessSource {
    const definition = DEFINITIONS.find((entry) => entry.id === id);
    if (!definition) throw new BusinessDashboardError(404, "source_not_found", "Datenquelle nicht gefunden.");
    const base: BusinessSource = {
      ...definition,
      state: "not_refreshed",
      fetchedAt: null,
      attemptedAt: null,
      message: "Noch nicht abgerufen.",
      metrics: [],
      records: [],
      limited: false,
    };
    if (!this.packs.byKey(this.options.companyId, definition.packKey))
      return { ...base, state: "not_installed", message: "Zugehöriges Gewerk zuerst installieren." };
    if (!this.options.getAdapter(definition.integration))
      return {
        ...base,
        state: "not_configured",
        message: "Integration nicht konfiguriert. Zugang auf dem Host einrichten.",
      };
    return this.cache.get(id) ?? base;
  }
  private boundApproval(source: BusinessSource, agentId: string): ApprovalRow | undefined {
    return this.options.db
      .prepare(
        `
      SELECT approval.* FROM crew_approvals approval
      JOIN crew_audit_events binding ON binding.approval_id = approval.id
      WHERE binding.company_id = ? AND binding.action = 'business.source.approval_bound'
        AND binding.entity_id = ? AND json_extract(binding.details_json, '$.endpoint') = ?
        AND binding.created_at > ?
        AND approval.company_id = ? AND approval.requested_by = ?
        AND approval.proposed_action = ? AND approval.task_id IS NULL AND approval.run_id IS NULL
        AND approval.status IN ('pending', 'approved')
        AND (approval.expires_at IS NULL OR approval.expires_at > ?)
        AND NOT EXISTS (SELECT 1 FROM crew_audit_events used
          WHERE used.company_id = ? AND used.action = 'business.source.approval_consumed' AND used.approval_id = approval.id)
      ORDER BY binding.seq DESC LIMIT 1
    `,
      )
      .get(
        this.options.companyId,
        source.id,
        source.endpoint,
        Date.now() - 15 * 60_000,
        this.options.companyId,
        agentId,
        source.toolKey,
        Date.now(),
        this.options.companyId,
      ) as ApprovalRow | undefined;
  }

  /** A grant is still required; an approval authorizes exactly one fixed read. */
  private authorize(source: BusinessSource, agentId: string, actorId: string, correlationId: string): GateResult {
    const decision = new ToolStore(this.options.db).resolve(this.options.companyId, agentId, source.toolKey);
    if (decision.allowed && decision.requiresApproval) {
      this.options.db.exec("SAVEPOINT crew_business_approval");
      try {
        const approval = this.boundApproval(source, agentId);
        if (approval?.status === "approved") {
          appendAuditEvent(this.options.db, {
            companyId: this.options.companyId,
            actorType: "owner",
            actorId,
            action: "business.source.approval_consumed",
            entityType: "integration",
            entityId: source.id,
            approvalId: approval.id,
            correlationId,
            details: { agentId, toolKey: source.toolKey, endpoint: source.endpoint },
          });
          this.options.db.exec("RELEASE SAVEPOINT crew_business_approval");
          return { outcome: "allowed" };
        }
        this.options.db.exec("RELEASE SAVEPOINT crew_business_approval");
        if (approval) return { outcome: "approval_required", approvalId: approval.id };
      } catch (error) {
        this.options.db.exec("ROLLBACK TO SAVEPOINT crew_business_approval");
        this.options.db.exec("RELEASE SAVEPOINT crew_business_approval");
        throw error;
      }
    }
    const gate = this.options.gate(agentId, source.toolKey);
    if (gate.outcome === "approval_required")
      appendAuditEvent(this.options.db, {
        companyId: this.options.companyId,
        actorType: "owner",
        actorId,
        action: "business.source.approval_bound",
        entityType: "integration",
        entityId: source.id,
        approvalId: gate.approvalId,
        correlationId,
        details: { agentId, toolKey: source.toolKey, endpoint: source.endpoint },
      });
    return gate;
  }

  async refresh(id: string, agentId: string, actorId: string): Promise<BusinessDashboardSnapshot> {
    const source = this.source(id);
    if (!this.options.agents().some((agent) => agent.id === agentId))
      throw new BusinessDashboardError(400, "unknown_agent", "Mitarbeiter dieser Firma auswählen.");
    if (this.refreshing.has(id))
      throw new BusinessDashboardError(409, "refresh_in_progress", "Diese Datenquelle wird bereits aktualisiert.");
    if (source.state === "not_configured" || source.state === "not_installed") return this.snapshot();
    this.refreshing.add(id);
    const correlationId = randomUUID();
    const base = {
      ...source,
      attemptedAt: Date.now(),
      fetchedAt: null,
      metrics: [],
      records: [],
      limited: false,
      approvalId: undefined,
    };
    const audit = (outcome: "ok" | "denied" | "failed", state: string) =>
      appendAuditEvent(this.options.db, {
        companyId: this.options.companyId,
        actorType: "owner",
        actorId,
        action: "business.source.refresh",
        entityType: "integration",
        entityId: id,
        correlationId,
        outcome,
        details: { agentId, toolKey: source.toolKey, endpoint: source.endpoint, state },
      });
    try {
      const gate = this.authorize(source, agentId, actorId, correlationId);
      if (gate.outcome !== "allowed") {
        this.cache.set(id, {
          ...base,
          state: gate.outcome,
          message:
            gate.outcome === "denied"
              ? "Werkzeug nicht freigegeben. Agentenrechte im Werkzeugbereich prüfen."
              : "Werkzeug benötigt eine Freigabe. Es wurden keine Daten abgerufen.",
          ...(gate.outcome === "approval_required" ? { approvalId: gate.approvalId } : {}),
        });
        audit("denied", gate.outcome);
        return this.snapshot();
      }
      // Audit intent before network activity; a failed audit must prevent access.
      audit("ok", "started");
      const data = await collect(source.id, this.options.getAdapter(source.integration)!);
      this.cache.set(id, {
        ...base,
        ...data,
        fetchedAt: Date.now(),
        state: "ok",
        message: data.limited
          ? "Begrenzter Ausschnitt. Kennzahlen beziehen sich auf die geladene Auswahl."
          : "Vom Quellsystem gelieferte Auswahl. Keine Hochrechnung.",
      });
      audit("ok", "completed");
    } catch {
      this.cache.set(id, {
        ...base,
        state: "error",
        message:
          "Abruf fehlgeschlagen. Verbindung, Leserechte und Antwortformat prüfen. Es wird kein Nullwert angenommen.",
      });
      audit("failed", "error");
    } finally {
      this.refreshing.delete(id);
    }
    return this.snapshot();
  }
}

function count(key: string, label: string, value: number): BusinessMetric {
  return { key, label, value, unit: "count" };
}
function record(id: unknown, label: unknown, status: unknown): BusinessRecord {
  const text = (value: unknown) =>
    typeof value === "string" || typeof value === "number"
      ? redact(String(value))
          .text.replace(/\p{Cc}/gu, " ")
          .slice(0, 160)
      : "Unbekannt";
  return { id: text(id), label: text(label), status: text(status) };
}
async function collect(
  id: BusinessSource["id"],
  adapter: PackIntegrationAdapter,
): Promise<Pick<BusinessSource, "metrics" | "records" | "limited">> {
  let records: BusinessRecord[];
  let metrics: BusinessMetric[];
  let limited = false;
  if (id === "proxmox" && adapter instanceof ProxmoxAdapter) {
    const guests = (await adapter.listGuests()).filter((guest) => !guest.template);
    records = guests.map((guest) => record(guest.vmid, guest.name, guest.status));
    metrics = [
      count("guests", "Gäste ohne Templates", guests.length),
      count("stopped", "Status stopped", guests.filter((guest) => guest.status === "stopped").length),
    ];
  } else if (id === "rmm-agents" && adapter instanceof TacticalRmmAdapter) {
    const agents = await adapter.listAgents();
    records = agents.map((agent) => record(agent.agentId, agent.hostname, agent.status));
    metrics = [
      count("endpoints", "Gelieferte Endpunkte", agents.length),
      count("online", "Status online", agents.filter((agent) => agent.status === "online").length),
    ];
  } else if (id === "rmm-alerts" && adapter instanceof TacticalRmmAdapter) {
    const alerts = await adapter.listAlerts();
    records = alerts.map((alert) => record(alert.id, alert.agent ?? "Systemalarm", alert.severity));
    metrics = [
      count("alerts", "Offene, nicht stummgeschaltete Alarme", alerts.length),
      count("errors", "Schweregrad error", alerts.filter((alert) => alert.severity === "error").length),
    ];
  } else if (id === "unifi" && adapter instanceof UnifiAdapter) {
    const devices = await adapter.listDevices({ maxPages: 1 });
    records = devices.map((device) => record(device.id, device.name, device.state));
    limited = true;
    metrics = [
      count("devices", "Geräte in erster Seite", devices.length),
      count("online", "Davon Status ONLINE", devices.filter((device) => device.state === "ONLINE").length),
    ];
  } else if (id === "sevdesk" && adapter instanceof SevdeskAdapter) {
    const page = await adapter.listInvoices({ status: 200, limit: 100, countAll: true, embed: [] });
    records = page.items.map((invoice) => record(invoice.id, invoice.number, invoice.status));
    limited = page.hasMore;
    metrics = [count("loaded", "Geladene offene Rechnungen", page.items.length)];
    if (page.total !== undefined) metrics.push(count("total", "Offene Rechnungen laut Quelle", page.total));
  } else if (id === "lexware" && adapter instanceof LexwareOfficeAdapter) {
    const page = await adapter.listVouchers({ types: ["invoice"], status: ["open"], size: 100, page: 0 });
    records = page.vouchers.map((invoice) => record(invoice.id, invoice.number, invoice.status));
    limited = page.hasMore;
    metrics = [
      count("loaded", "Geladene offene Rechnungen", page.vouchers.length),
      count("overdue", "Davon laut Quelle überfällig", page.vouchers.filter((invoice) => invoice.overdue).length),
    ];
  } else throw new Error("Adapter capability unavailable");
  if (metrics.some((metric) => !Number.isSafeInteger(metric.value) || metric.value < 0))
    throw new Error("Invalid metric");
  return { metrics, records: records.slice(0, 100), limited: limited || records.length > 100 };
}
