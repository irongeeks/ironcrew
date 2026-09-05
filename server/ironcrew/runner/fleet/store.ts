import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { allRows, oneRow } from "../../domain/sql.ts";
import { appendAuditEvent } from "../../domain/audit.ts";
import {
  enrollmentSchema,
  permitsContext,
  type EnrollmentInput,
  type FleetWorker,
  type FleetLease,
  type RuntimeDescriptor,
} from "./types.ts";
import type { RunContext } from "../../runtime/run-events.ts";

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
const CREDENTIAL_TTL = 30 * 86400_000;
export const FLEET_LEASE_MS = 60_000;
export class FleetUnavailableError extends Error {
  constructor(
    message: string,
    readonly retryAt: number,
  ) {
    super(message);
    this.name = "FleetUnavailableError";
  }
}
interface Row {
  id: string;
  company_id: string;
  label: string;
  workspace_root: string;
  runtime_types: string;
  project_ids: string;
  allow_unscoped: number;
  max_concurrent: number;
  priority: number;
  revoked_at: number | null;
  credential_hash: string | null;
  previous_hash: string | null;
  previous_expires_at: number | null;
  credential_expires_at: number | null;
  generation: number;
  connected: number;
  last_seen_at: number | null;
  runtimes: string;
}
export class FleetStore {
  constructor(
    readonly db: DatabaseSync,
    readonly companyId: string,
    private readonly now: () => number = Date.now,
  ) {}
  private transaction<T>(fn: () => T): T {
    this.db.exec("SAVEPOINT fleet_mutation");
    try {
      const result = fn();
      this.db.exec("RELEASE fleet_mutation");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK TO fleet_mutation; RELEASE fleet_mutation");
      throw error;
    }
  }
  private row(id: string): Row | null {
    return oneRow<Row>(
      this.db.prepare("SELECT * FROM crew_fleet_workers WHERE id=? AND company_id=?"),
      id,
      this.companyId,
    );
  }
  private view(row: Row): FleetWorker {
    return {
      id: row.id,
      companyId: row.company_id,
      label: row.label,
      workspaceRoot: row.workspace_root,
      runtimeTypes: JSON.parse(row.runtime_types),
      projectIds: JSON.parse(row.project_ids),
      allowUnscoped: !!row.allow_unscoped,
      maxConcurrent: row.max_concurrent,
      priority: row.priority,
      state:
        row.revoked_at !== null
          ? "revoked"
          : row.connected && (row.last_seen_at ?? 0) > this.now() - FLEET_LEASE_MS
            ? "online"
            : "offline",
      generation: row.generation,
      lastSeenAt: row.last_seen_at,
      credentialExpiresAt: row.credential_expires_at,
      activeLeases: oneRow<{ n: number }>(
        this.db.prepare(
          "SELECT COUNT(*) n FROM crew_fleet_leases WHERE worker_id=? AND state IN ('active','lost','revoked') AND expires_at>?",
        ),
        row.id,
        this.now(),
      )!.n,
      runtimes: JSON.parse(row.runtimes),
    };
  }
  get(id: string): FleetWorker | null {
    const row = this.row(id);
    return row ? this.view(row) : null;
  }
  list(): FleetWorker[] {
    return allRows<Row>(
      this.db.prepare("SELECT * FROM crew_fleet_workers WHERE company_id=? ORDER BY label,id"),
      this.companyId,
    ).map((row) => this.view(row));
  }
  private audit(action: string, id: string, actorId = "fleet", details: Record<string, unknown> = {}) {
    appendAuditEvent(this.db, {
      companyId: this.companyId,
      actorType: actorId === "fleet" ? "system" : "owner",
      actorId,
      action: `fleet.${action}`,
      entityType: "fleet_worker",
      entityId: id,
      details,
    });
  }
  create(input: EnrollmentInput, actorId: string) {
    const scope = enrollmentSchema.parse(input);
    for (const projectId of scope.projectIds)
      if (
        !oneRow(this.db.prepare("SELECT id FROM crew_projects WHERE id=? AND company_id=?"), projectId, this.companyId)
      )
        throw new Error("Project does not belong to this company");
    return this.transaction(() => {
      const id = `worker_${randomUUID()}`;
      this.db
        .prepare(
          "INSERT INTO crew_fleet_workers(id,company_id,label,workspace_root,runtime_types,project_ids,allow_unscoped,max_concurrent,priority,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          id,
          this.companyId,
          scope.label,
          path.resolve(scope.workspaceRoot),
          JSON.stringify([...new Set(scope.runtimeTypes)]),
          JSON.stringify([...new Set(scope.projectIds)]),
          Number(scope.allowUnscoped),
          scope.maxConcurrent,
          scope.priority,
          this.now(),
        );
      this.audit("created", id, actorId, {
        label: scope.label,
        runtimeTypes: scope.runtimeTypes,
        projectIds: scope.projectIds,
      });
      return { worker: this.get(id)!, enrollment: this.issue(id, scope.ttlSeconds, actorId) };
    });
  }
  issue(id: string, ttlSeconds = 600, actorId = "fleet") {
    return this.transaction(() => {
      const row = this.row(id);
      if (!row || row.revoked_at !== null) throw new Error("Worker unavailable");
      if (!Number.isInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 900)
        throw new Error("Invalid enrollment lifetime");
      this.db
        .prepare("UPDATE crew_fleet_enrollments SET consumed_at=? WHERE worker_id=? AND consumed_at IS NULL")
        .run(this.now(), id);
      const token = secret(),
        expiresAt = this.now() + ttlSeconds * 1000;
      this.db
        .prepare("INSERT INTO crew_fleet_enrollments(id,worker_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,?)")
        .run(randomUUID(), id, hash(token), expiresAt, this.now());
      this.audit("enrollment_issued", id, actorId, { expiresAt });
      return { token, expiresAt };
    });
  }
  enroll(token: string): { worker: FleetWorker; credential: string } | null {
    return this.transaction(() => {
      const enrollment = oneRow<{ id: string; worker_id: string }>(
        this.db.prepare(
          "SELECT e.id,e.worker_id FROM crew_fleet_enrollments e JOIN crew_fleet_workers w ON w.id=e.worker_id WHERE e.token_hash=? AND e.consumed_at IS NULL AND e.expires_at>? AND w.company_id=? AND w.revoked_at IS NULL",
        ),
        hash(token),
        this.now(),
        this.companyId,
      );
      if (!enrollment) return null;
      this.db.prepare("UPDATE crew_fleet_enrollments SET consumed_at=? WHERE id=?").run(this.now(), enrollment.id);
      const credential = secret();
      this.db
        .prepare(
          "UPDATE crew_fleet_workers SET credential_hash=?,previous_hash=NULL,previous_expires_at=NULL,credential_expires_at=? WHERE id=?",
        )
        .run(hash(credential), this.now() + CREDENTIAL_TTL, enrollment.worker_id);
      this.audit("enrolled", enrollment.worker_id);
      return { worker: this.get(enrollment.worker_id)!, credential };
    });
  }
  authenticate(token: string): FleetWorker | null {
    const row = oneRow<Row>(
      this.db.prepare(
        "SELECT * FROM crew_fleet_workers WHERE company_id=? AND revoked_at IS NULL AND credential_expires_at>? AND (credential_hash=? OR (previous_hash=? AND previous_expires_at>?))",
      ),
      this.companyId,
      this.now(),
      hash(token),
      hash(token),
      this.now(),
    );
    return row ? this.view(row) : null;
  }
  rotate(id: string, force = false): { credential: string; expiresAt: number } | null {
    const row = this.row(id);
    if (!row || row.revoked_at !== null) throw new Error("Worker unavailable");
    if (!force && (row.credential_expires_at ?? 0) > this.now() + 86400_000) return null;
    return this.transaction(() => {
      const credential = secret(),
        expiresAt = this.now() + CREDENTIAL_TTL;
      this.db
        .prepare(
          "UPDATE crew_fleet_workers SET previous_hash=credential_hash,previous_expires_at=?,credential_hash=?,credential_expires_at=? WHERE id=?",
        )
        .run(this.now() + 120_000, hash(credential), expiresAt, id);
      this.audit("credential_rotated", id);
      return { credential, expiresAt };
    });
  }
  connect(id: string): FleetWorker {
    return this.transaction(() => {
      const row = this.row(id);
      if (!row || row.revoked_at !== null || (row.credential_expires_at ?? 0) <= this.now())
        throw new Error("Worker unavailable");
      this.lose(id);
      this.db
        .prepare("UPDATE crew_fleet_workers SET generation=generation+1,connected=1,last_seen_at=? WHERE id=?")
        .run(this.now(), id);
      this.audit("connected", id);
      return this.get(id)!;
    });
  }
  heartbeat(id: string, generation: number, runtimes?: RuntimeDescriptor[]): boolean {
    const result = this.db
      .prepare(
        "UPDATE crew_fleet_workers SET last_seen_at=?,runtimes=COALESCE(?,runtimes) WHERE id=? AND company_id=? AND generation=? AND connected=1 AND revoked_at IS NULL AND credential_expires_at>?",
      )
      .run(this.now(), runtimes ? JSON.stringify(runtimes) : null, id, this.companyId, generation, this.now());
    if (!result.changes) return false;
    this.db
      .prepare("UPDATE crew_fleet_leases SET expires_at=? WHERE worker_id=? AND generation=? AND state='active'")
      .run(this.now() + FLEET_LEASE_MS, id, generation);
    return true;
  }
  disconnect(id: string, generation: number) {
    if (this.row(id)?.generation !== generation) return;
    this.transaction(() => {
      this.db.prepare("UPDATE crew_fleet_workers SET connected=0 WHERE id=?").run(id);
      this.lose(id);
      this.audit("disconnected", id);
    });
  }
  private lose(id: string, state: "lost" | "revoked" = "lost") {
    this.db
      .prepare("UPDATE crew_fleet_leases SET state=?,ended_at=? WHERE worker_id=? AND state='active'")
      .run(state, this.now(), id);
  }
  recover() {
    this.transaction(() => {
      for (const worker of this.list()) {
        this.db.prepare("UPDATE crew_fleet_workers SET connected=0 WHERE id=?").run(worker.id);
        this.lose(worker.id);
        if (worker.state === "online" || worker.activeLeases > 0) this.audit("recovered", worker.id);
      }
    });
  }
  revoke(id: string, actorId: string): FleetWorker {
    return this.transaction(() => {
      if (!this.row(id)) throw new Error("Worker not found");
      this.db
        .prepare(
          "UPDATE crew_fleet_workers SET revoked_at=?,connected=0,credential_hash=NULL,previous_hash=NULL,generation=generation+1 WHERE id=?",
        )
        .run(this.now(), id);
      this.db
        .prepare("UPDATE crew_fleet_enrollments SET consumed_at=? WHERE worker_id=? AND consumed_at IS NULL")
        .run(this.now(), id);
      this.lose(id, "revoked");
      this.audit("revoked", id, actorId);
      return this.get(id)!;
    });
  }
  reserve(
    type: string,
    context: RunContext,
    connected: ReadonlySet<string>,
    sessionRef?: string,
  ): { worker: FleetWorker; lease: FleetLease } {
    return this.transaction(() => {
      this.db
        .prepare(
          "UPDATE crew_fleet_leases SET state='lost',ended_at=? WHERE company_id=? AND state='active' AND expires_at<=?",
        )
        .run(this.now(), this.companyId, this.now());
      if (
        oneRow(
          this.db.prepare(
            "SELECT id FROM crew_fleet_leases WHERE company_id=? AND task_id=? AND state IN ('lost','revoked') AND expires_at>?",
          ),
          this.companyId,
          context.taskId,
          this.now(),
        )
      )
        throw new FleetUnavailableError(
          "Previous fleet task lease is still draining; retry after lease expiry",
          this.now() + FLEET_LEASE_MS,
        );
      const sessionWorker = sessionRef
        ? oneRow<{ worker_id: string | null }>(
            this.db.prepare(
              "SELECT worker_id FROM crew_runs WHERE company_id=? AND task_id=? AND agent_id IS ? AND runtime_type=? AND session_ref=? AND workspace_path=? ORDER BY created_at DESC, rowid DESC LIMIT 1",
            ),
            this.companyId,
            context.taskId,
            context.agentId,
            type,
            sessionRef,
            context.workspacePath,
          )?.worker_id
        : undefined;
      if (sessionRef && !sessionWorker) throw new Error("No original fleet worker for this session");
      const worker = this.list()
        .filter(
          (w) =>
            connected.has(w.id) &&
            (!sessionWorker || w.id === sessionWorker) &&
            w.state === "online" &&
            (w.credentialExpiresAt ?? 0) > this.now() &&
            w.activeLeases < w.maxConcurrent &&
            permitsContext(w, type, context) &&
            w.runtimes.some(
              (r) =>
                r.type === type &&
                r.health.healthy &&
                (!sessionRef || r.capabilities.sessionResume) &&
                r.health.installed &&
                (!!context.workspacePath || r.capabilities.workspaceRequired === false),
            ),
        )
        .sort((a, b) => a.activeLeases - b.activeLeases || b.priority - a.priority || a.id.localeCompare(b.id))[0];
      if (!worker)
        throw new FleetUnavailableError(
          "No healthy fleet worker matches the assigned company, runtime and workspace scope",
          this.now() + FLEET_LEASE_MS,
        );
      const id = randomUUID();
      this.db
        .prepare(
          "INSERT INTO crew_fleet_leases(id,worker_id,company_id,project_id,task_id,run_id,generation,state,expires_at,created_at) VALUES(?,?,?,?,?,?,?,'active',?,?)",
        )
        .run(
          id,
          worker.id,
          this.companyId,
          context.projectId,
          context.taskId,
          context.runId,
          worker.generation,
          this.now() + FLEET_LEASE_MS,
          this.now(),
        );
      this.db
        .prepare("UPDATE crew_runs SET worker_id=? WHERE id=? AND company_id=? AND task_id=?")
        .run(worker.id, context.runId, this.companyId, context.taskId);
      appendAuditEvent(this.db, {
        companyId: this.companyId,
        actorType: "system",
        actorId: "fleet",
        action: "fleet.task_claimed",
        entityType: "fleet_worker",
        entityId: worker.id,
        taskId: context.taskId,
        runId: context.runId,
        correlationId: context.correlationId,
        details: { leaseId: id, generation: worker.generation },
      });
      return { worker, lease: oneRow<FleetLease>(this.db.prepare("SELECT * FROM crew_fleet_leases WHERE id=?"), id)! };
    });
  }
  release(id: string, completed = true) {
    this.db
      .prepare("UPDATE crew_fleet_leases SET state=?,ended_at=? WHERE id=? AND company_id=? AND state='active'")
      .run(completed ? "completed" : "lost", this.now(), id, this.companyId);
  }
  leases(): FleetLease[] {
    return allRows<FleetLease>(
      this.db.prepare("SELECT * FROM crew_fleet_leases WHERE company_id=? ORDER BY created_at DESC LIMIT 500"),
      this.companyId,
    );
  }
}
