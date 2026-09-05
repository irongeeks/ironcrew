/** Original routing policy: explicit owner revisions, no inferred models or fallback chains. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { load as yaml } from "js-yaml";
import { z } from "zod";
import {
  routingConfigSchema,
  type RoutingConfig,
  type RoutingProfile,
  type RoutingSnapshot,
  type RouteTarget,
} from "../../../src/shared/routing-profiles.ts";
import { appendAuditEvent } from "./audit.ts";
import { type VesselRow, VesselStore } from "./vessel-store.ts";
import { evaluateModel, type VendorPolicy } from "../policy/vendor-policy.ts";
import { CompanyPolicyStore } from "../policy/company-policy-store.ts";
import { redact } from "../security/redaction.ts";

export class RoutingError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 409,
  ) {
    super(message);
    this.name = "RoutingError";
  }
}
export interface RoutingRevision {
  revision: number;
  config: RoutingConfig;
}
const ALIAS_VENDOR: Partial<Record<RouteTarget["runtimeType"], string>> = {
  claude: "anthropic",
  codex: "openai",
  antigravity: "google",
  gemini: "google",
  mock: "openai",
};
export class RoutingStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly configPath = path.resolve("config/routing-profiles.yaml"),
    private readonly policy: (companyId: string) => VendorPolicy = (companyId) =>
      new CompanyPolicyStore(db).effective(companyId),
  ) {}
  private atomic<T>(action: () => T): T {
    this.db.exec("SAVEPOINT routing_change");
    try {
      const value = action();
      this.db.exec("RELEASE routing_change");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK TO routing_change; RELEASE routing_change");
      throw error;
    }
  }
  private owner(actorId: string): void {
    const user = this.db.prepare("SELECT role,status FROM crew_users WHERE id=?").get(actorId) as
      | { role: string; status: string }
      | undefined;
    const { n } = this.db.prepare("SELECT COUNT(*) AS n FROM crew_users").get() as { n: number };
    if (n === 0 && actorId === "ceo") return;
    if (user?.role !== "owner" || user.status !== "active")
      throw new RoutingError("owner_required", "Nur aktive Owner dürfen Routing ändern.", 403);
  }
  private audit(
    companyId: string,
    actorId: string,
    action: string,
    details: Record<string, unknown>,
    system = false,
  ): void {
    appendAuditEvent(this.db, {
      companyId,
      actorType: system ? "system" : "owner",
      actorId,
      action,
      entityType: "routing",
      entityId: companyId,
      correlationId: `corr_${randomUUID()}`,
      details,
    });
  }
  target(companyId: string, target: RouteTarget): VesselRow {
    const vessel = new VesselStore(this.db).get(target.vesselId);
    if (!vessel || vessel.company_id !== companyId)
      throw new RoutingError("vessel_scope", "Routing-Vessel gehört nicht zu dieser Firma.", 403);
    if (vessel.runtime_provider !== target.runtimeType)
      throw new RoutingError("vessel_changed", "Vessel-Runtime wurde geändert. Profil neu prüfen und speichern.");
    if (
      target.runtimeType !== "mock" &&
      ALIAS_VENDOR[target.runtimeType] &&
      target.model.includes("/") &&
      !target.model.startsWith(ALIAS_VENDOR[target.runtimeType] + "/")
    )
      throw new RoutingError("runtime_vendor", "Modell gehört nicht zum offiziellen CLI-Anbieter.", 403);
    const canonical = target.model.includes("/")
      ? target.model
      : `${ALIAS_VENDOR[target.runtimeType] ?? ""}/${target.model}`;
    if (target.vendorModel !== canonical)
      throw new RoutingError(
        "model_identity",
        "Vendor-ID muss exakt dem Modell entsprechen; CLI-Alias benötigt den festen Runtime-Vendorpräfix.",
        400,
      );
    const policy = this.policy(companyId);
    const actual = evaluateModel(policy, target.model, target.runtimeType);
    const vendor = evaluateModel(policy, target.vendorModel, target.runtimeType);
    if (
      actual.code === "blocked_family" ||
      !vendor.allowed ||
      (target.runtimeType === "openrouter" && policy.openrouter.allowed_providers.length === 0)
    )
      throw new RoutingError("vendor_denied", "Modell oder Anbieter durch zentrale Vendor-Policy gesperrt.", 403);
    return vessel;
  }
  current(companyId: string): RoutingRevision {
    const row = this.db
      .prepare(
        "SELECT revision,config_json FROM crew_routing_revisions WHERE company_id=? ORDER BY revision DESC LIMIT 1",
      )
      .get(companyId) as { revision: number; config_json: string } | undefined;
    if (row) return { revision: row.revision, config: routingConfigSchema.parse(JSON.parse(row.config_json)) };
    return this.atomic(() => {
      const config = routingConfigSchema.parse(yaml(readFileSync(this.configPath, "utf8")));
      for (const profile of config.profiles)
        for (const target of [...(profile.primary ? [profile.primary] : []), ...profile.fallbacks])
          this.target(companyId, target);
      this.db
        .prepare(
          "INSERT INTO crew_routing_revisions(company_id,revision,config_json,created_by,created_at) VALUES (?,1,?,'config-bootstrap',?)",
        )
        .run(companyId, JSON.stringify(config), Date.now());
      this.audit(companyId, "config-bootstrap", "routing.initialized", { revision: 1 }, true);
      return { revision: 1, config };
    });
  }
  snapshot(companyId: string): RoutingSnapshot {
    const current = this.current(companyId);
    return {
      ...current,
      bindings: this.db
        .prepare(
          "SELECT agent_id AS agentId,profile_key AS profileKey FROM crew_agent_routing WHERE company_id=? ORDER BY agent_id",
        )
        .all(companyId) as unknown as RoutingSnapshot["bindings"],
      vessels: new VesselStore(this.db)
        .list(companyId)
        .map(({ id, key, label, runtime_provider, model }) => ({ id, key, label, runtime_provider, model })),
      history: this.db
        .prepare(
          "SELECT revision,created_at AS createdAt,created_by AS createdBy FROM crew_routing_revisions WHERE company_id=? ORDER BY revision DESC LIMIT 100",
        )
        .all(companyId) as unknown as RoutingSnapshot["history"],
    };
  }
  save(companyId: string, raw: unknown, actorId: string): RoutingSnapshot {
    this.owner(actorId);
    const input = z
      .object({ expectedRevision: z.number().int().positive(), config: routingConfigSchema })
      .strict()
      .parse(raw);
    const encoded = JSON.stringify(input.config);
    if (redact(encoded).text !== encoded)
      throw new RoutingError("secret_in_config", "Routing-Konfiguration darf keine Secrets enthalten.", 400);
    return this.atomic(() => {
      const current = this.current(companyId);
      if (current.revision !== input.expectedRevision)
        throw new RoutingError(
          "stale_revision",
          "Routing wurde inzwischen geändert. Neu laden und Änderungen erneut prüfen.",
        );
      for (const profile of input.config.profiles) {
        if (
          !profile.primary &&
          this.db
            .prepare("SELECT 1 FROM crew_agent_routing WHERE company_id=? AND profile_key=?")
            .get(companyId, profile.key)
        )
          throw new RoutingError(
            "profile_in_use",
            "Zugewiesenes Profil benötigt eine Primärroute. Zuweisung zuerst aufheben.",
          );
        for (const target of [...(profile.primary ? [profile.primary] : []), ...profile.fallbacks])
          this.target(companyId, target);
      }
      const revision = current.revision + 1;
      this.db
        .prepare(
          "INSERT INTO crew_routing_revisions(company_id,revision,config_json,created_by,created_at) VALUES (?,?,?,?,?)",
        )
        .run(companyId, revision, encoded, actorId, Date.now());
      this.audit(companyId, actorId, "routing.updated", {
        revision,
        previousRevision: current.revision,
        profiles: input.config.profiles.map((p) => ({ key: p.key, allowFallback: p.allowFallback })),
      });
      return this.snapshot(companyId);
    });
  }
  bind(companyId: string, agentId: string, raw: unknown, actorId: string): RoutingSnapshot {
    this.owner(actorId);
    const { profileKey } = z
      .object({ profileKey: z.string().min(1).max(100).nullable() })
      .strict()
      .parse(raw);
    if (!this.db.prepare("SELECT 1 FROM crew_agents WHERE company_id=? AND id=?").get(companyId, agentId))
      throw new RoutingError("agent_scope", "Agent nicht gefunden.", 404);
    return this.atomic(() => {
      const current = this.current(companyId);
      if (profileKey) {
        const profile = current.config.profiles.find((p) => p.key === profileKey);
        if (!profile?.primary)
          throw new RoutingError("profile_unconfigured", "Das Profil ist nicht vollständig konfiguriert.", 400);
        this.target(companyId, profile.primary);
        this.db
          .prepare(
            "INSERT INTO crew_agent_routing(company_id,agent_id,profile_key,updated_at) VALUES (?,?,?,?) ON CONFLICT(company_id,agent_id) DO UPDATE SET profile_key=excluded.profile_key,updated_at=excluded.updated_at",
          )
          .run(companyId, agentId, profileKey, Date.now());
      } else
        this.db.prepare("DELETE FROM crew_agent_routing WHERE company_id=? AND agent_id=?").run(companyId, agentId);
      this.audit(companyId, actorId, "routing.agent_bound", { agentId, profileKey, revision: current.revision });
      return this.snapshot(companyId);
    });
  }
  binding(companyId: string, agentId: string): { revision: number; profile: RoutingProfile } | null {
    const row = this.db
      .prepare("SELECT profile_key FROM crew_agent_routing WHERE company_id=? AND agent_id=?")
      .get(companyId, agentId) as { profile_key: string } | undefined;
    if (!row) return null;
    const current = this.current(companyId);
    const profile = current.config.profiles.find((p) => p.key === row.profile_key);
    if (!profile?.primary)
      throw new RoutingError("profile_unconfigured", "Zugewiesenes Routingprofil ist nicht verfügbar.");
    return { revision: current.revision, profile };
  }
  activeCount(companyId: string, vesselId: string, now = Date.now()): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM crew_runs r JOIN crew_agents a ON a.id=r.agent_id
      WHERE r.company_id=? AND (COALESCE(r.routing_vessel_id,a.vessel_id)=? OR COALESCE(r.routing_origin_vessel_id,a.vessel_id)=?) AND r.status IN ('queued','running')
      AND COALESCE(r.heartbeat_at,r.created_at)>?`,
      )
      .get(companyId, vesselId, vesselId, now - 120_000) as { n: number };
    const meetings = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM crew_routing_meeting_leases WHERE company_id=? AND (vessel_id=? OR origin_vessel_id=?) AND expires_at>?",
      )
      .get(companyId, vesselId, vesselId, now) as { n: number };
    return row.n + meetings.n;
  }
  reserveMeeting(companyId: string, meetingId: string, vessel: VesselRow, origin: VesselRow | null): string {
    return this.atomic(() => {
      if (
        this.activeCount(companyId, vessel.id) >= vessel.max_concurrency ||
        (origin && this.activeCount(companyId, origin.id) >= origin.max_concurrency)
      )
        throw new RoutingError("capacity", "Routing-Vessel ist belegt.", 503);
      const id = `route_${randomUUID()}`;
      this.db
        .prepare(
          "INSERT INTO crew_routing_meeting_leases(id,company_id,vessel_id,origin_vessel_id,meeting_id,expires_at) VALUES (?,?,?,?,?,?)",
        )
        .run(
          id,
          companyId,
          vessel.id,
          origin?.id ?? null,
          meetingId,
          Date.now() + Math.min(vessel.timeout_ms, origin?.timeout_ms ?? vessel.timeout_ms) + 10_000,
        );
      return id;
    });
  }
  releaseMeeting(id: string): void {
    this.db.prepare("DELETE FROM crew_routing_meeting_leases WHERE id=?").run(id);
  }
}
