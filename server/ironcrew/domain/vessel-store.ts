/**
 * IronCrew — vessels: the execution container an agent runs in.
 *
 * A vessel answers exactly two questions: which registered AgentRuntime
 * executes a run, and how long and how often that run may take. Several
 * agents share one vessel — that is the point of the split in migration
 * 0011: a role is no longer welded to a runtime.
 *
 * WHAT A VESSEL MUST NEVER CARRY
 *
 * No permission mode, no sandbox setting, no tool allowlist — not in the
 * table, and not in `VesselInput` either. CLI permission modes come from a
 * `SandboxGrant` that names the `ApprovalRequest` it was minted from and is
 * hard-capped at four hours (docs/THREAT_MODEL.md T-01). A vessel field
 * saying "elevated" would be a second route to elevation that no approval
 * ever authorised, and unlike a grant it would never expire.
 *
 * That is why `update()` below is not a column-spreader: it walks a fixed
 * map of known fields instead of the caller's object, so an unexpected key
 * arriving from a JSON body — `permission_mode`, `allowed_tools` — is
 * ignored rather than smuggled into the SET clause.
 *
 * Bounds are checked here as well as by the schema's CHECK constraints. A
 * CHECK failure surfaces as "CHECK constraint failed: crew_vessels", which
 * tells the owner nothing about which number was wrong.
 */

import type { DatabaseSync } from "node:sqlite";
import { newId } from "./ids.ts";
import { allRows, oneRow } from "./sql.ts";
import { appendAuditEvent, type ActorType } from "./audit.ts";

export interface VesselRow {
  id: string;
  company_id: string;
  key: string;
  label: string;
  runtime_provider: string;
  model: string;
  timeout_ms: number;
  max_retries: number;
  max_concurrency: number;
  created_at: number;
  updated_at: number;
}

const VESSEL_COLUMNS = `id, company_id, key, label, runtime_provider, model,
  timeout_ms, max_retries, max_concurrency, created_at, updated_at`;

export class VesselMutationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VesselMutationError";
  }
}

/**
 * Note what is absent, and stays absent: nothing about what a run may DO.
 * Adding such a field here is the change this module exists to prevent.
 */
export interface VesselInput {
  companyId: string;
  key: string;
  label?: string;
  runtimeProvider: string;
  model?: string;
  timeoutMs?: number;
  maxRetries?: number;
  maxConcurrency?: number;
}

/** Everything a patch may reach. `companyId` and `key` are identity, not settings. */
export type VesselPatch = Partial<Omit<VesselInput, "companyId" | "key">>;

export interface VesselActor {
  actorType?: ActorType;
  actorId?: string;
}

/**
 * The only writable columns, and the only fields a patch is read for. The
 * allowlist is the mechanism: `update()` iterates this map, never the
 * caller's object, so an unknown key cannot reach SQL at all.
 */
const PATCH_COLUMNS: Record<keyof VesselPatch, string> = {
  label: "label",
  runtimeProvider: "runtime_provider",
  model: "model",
  timeoutMs: "timeout_ms",
  maxRetries: "max_retries",
  maxConcurrency: "max_concurrency",
};

/** Defaults mirror the schema, so a vessel created here looks like a derived one. */
const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_MAX_CONCURRENCY = 1;

function assertLimit(field: "timeoutMs" | "maxRetries" | "maxConcurrency", value: number): void {
  if (!Number.isInteger(value)) {
    throw new VesselMutationError(`"${field}" muss eine ganze Zahl sein, war: ${String(value)}.`);
  }
  if (field === "timeoutMs" && value <= 0) {
    throw new VesselMutationError(`Das Timeout muss größer als 0 ms sein, war: ${value}.`);
  }
  if (field === "maxRetries" && value < 0) {
    throw new VesselMutationError(`Die Anzahl der Wiederholungen darf nicht negativ sein, war: ${value}.`);
  }
  if (field === "maxConcurrency" && value < 1) {
    throw new VesselMutationError(`Die Parallelität muss mindestens 1 betragen, war: ${value}.`);
  }
}

export class VesselStore {
  constructor(private readonly db: DatabaseSync) {}

  create(input: VesselInput, opts: VesselActor = {}): VesselRow {
    const key = input.key.trim();
    const runtimeProvider = input.runtimeProvider.trim();
    if (!key) throw new VesselMutationError("Ein Vessel braucht einen Key.");
    if (!runtimeProvider) throw new VesselMutationError("Ein Vessel braucht einen Runtime-Provider.");
    // Checked before the INSERT so the owner reads a sentence instead of
    // "UNIQUE constraint failed: crew_vessels.company_id, crew_vessels.key".
    if (this.byKey(input.companyId, key)) {
      throw new VesselMutationError(`Ein Vessel mit dem Key "${key}" existiert in dieser Firma bereits.`);
    }

    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxRetries = input.maxRetries ?? DEFAULT_MAX_RETRIES;
    const maxConcurrency = input.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
    assertLimit("timeoutMs", timeoutMs);
    assertLimit("maxRetries", maxRetries);
    assertLimit("maxConcurrency", maxConcurrency);

    const id = newId("vsl");
    this.db
      .prepare(
        `INSERT INTO crew_vessels
           (id, company_id, key, label, runtime_provider, model, timeout_ms, max_retries, max_concurrency)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.companyId,
        key,
        input.label ?? "",
        runtimeProvider,
        input.model ?? "",
        timeoutMs,
        maxRetries,
        maxConcurrency,
      );

    appendAuditEvent(this.db, {
      companyId: input.companyId,
      actorType: opts.actorType ?? "owner",
      actorId: opts.actorId ?? "ceo",
      action: "vessel.created",
      entityType: "vessel",
      entityId: id,
      details: { key, runtimeProvider, timeoutMs, maxRetries, maxConcurrency },
    });

    return this.get(id)!;
  }

  get(id: string): VesselRow | null {
    return oneRow<VesselRow>(this.db.prepare(`SELECT ${VESSEL_COLUMNS} FROM crew_vessels WHERE id = ?`), id);
  }

  byKey(companyId: string, key: string): VesselRow | null {
    return oneRow<VesselRow>(
      this.db.prepare(`SELECT ${VESSEL_COLUMNS} FROM crew_vessels WHERE company_id = ? AND key = ?`),
      companyId,
      key,
    );
  }

  list(companyId: string): VesselRow[] {
    return allRows<VesselRow>(
      this.db.prepare(`SELECT ${VESSEL_COLUMNS} FROM crew_vessels WHERE company_id = ? ORDER BY key ASC`),
      companyId,
    );
  }

  /**
   * Applies only the fields present in the patch. An omitted field keeps its
   * stored value, an explicitly passed one is written, and anything not in
   * PATCH_COLUMNS — including a key rename, which is identity rather than a
   * setting — is ignored without comment.
   */
  update(id: string, patch: VesselPatch, opts: VesselActor = {}): VesselRow | null {
    const vessel = this.get(id);
    if (!vessel) return null;

    const source = patch as Record<string, unknown>;
    const columns: string[] = [];
    const params: unknown[] = [];
    const changed: string[] = [];

    for (const [field, column] of Object.entries(PATCH_COLUMNS) as Array<[keyof VesselPatch, string]>) {
      const value = source[field];
      if (value === undefined) continue;

      if (field === "timeoutMs" || field === "maxRetries" || field === "maxConcurrency") {
        assertLimit(field, value as number);
      }
      if (field === "runtimeProvider" && !String(value).trim()) {
        throw new VesselMutationError("Ein Vessel braucht einen Runtime-Provider.");
      }

      columns.push(`${column} = ?`);
      params.push(typeof value === "string" ? value.trim() : value);
      changed.push(field);
    }

    // A patch that carried nothing this store owns changes nothing at all —
    // not even updated_at, and no audit entry claiming an edit that did not
    // happen.
    if (columns.length === 0) return vessel;

    this.db
      .prepare(`UPDATE crew_vessels SET ${columns.join(", ")}, updated_at = ? WHERE id = ?`)
      .run(...(params as never[]), Date.now(), id);

    appendAuditEvent(this.db, {
      companyId: vessel.company_id,
      actorType: opts.actorType ?? "owner",
      actorId: opts.actorId ?? "ceo",
      action: "vessel.updated",
      entityType: "vessel",
      entityId: id,
      details: { key: vessel.key, fields: changed },
    });
    return this.get(id);
  }

  /**
   * Deleting a vessel agents still run in is refused, not cascaded: the FK is
   * ON DELETE RESTRICT, and SQLite answers that with a bare "FOREIGN KEY
   * constraint failed". Naming the agents turns it into something the owner
   * can act on — reassign these three, then delete.
   */
  delete(id: string, opts: VesselActor = {}): void {
    const vessel = this.get(id);
    // Nothing to delete and nothing to audit; the caller's intent already holds.
    if (!vessel) return;

    const agents = this.agentsFor(id);
    if (agents.length > 0) {
      throw new VesselMutationError(
        `Das Vessel "${vessel.key}" wird noch von ${agents.length} Agent(en) verwendet ` +
          `(${agents.map((a) => a.key).join(", ")}). Weise diese Agenten zuerst einem anderen Vessel zu.`,
      );
    }

    try {
      this.db.prepare("DELETE FROM crew_vessels WHERE id = ?").run(id);
    } catch {
      // The check above answers the ordinary case; this catches an agent bound
      // between the two statements, so a raw constraint error still never
      // reaches the API.
      throw new VesselMutationError(
        `Das Vessel "${vessel.key}" wird noch von Agenten verwendet und kann nicht gelöscht werden.`,
      );
    }

    appendAuditEvent(this.db, {
      companyId: vessel.company_id,
      actorType: opts.actorType ?? "owner",
      actorId: opts.actorId ?? "ceo",
      action: "vessel.deleted",
      entityType: "vessel",
      entityId: id,
      details: { key: vessel.key, runtimeProvider: vessel.runtime_provider },
    });
  }

  /** Who would be affected by a change to this vessel — and who blocks its deletion. */
  agentsFor(vesselId: string): Array<{ id: string; key: string; display_name: string }> {
    return allRows<{ id: string; key: string; display_name: string }>(
      this.db.prepare(`SELECT id, key, display_name FROM crew_agents WHERE vessel_id = ? ORDER BY key ASC`),
      vesselId,
    );
  }
}
