/** Original IronCrew career governance. Scores describe this workflow, not an objective model benchmark. */
import type { DatabaseSync } from "node:sqlite";
import {
  CAREER_FALLBACK_REVIEWER_ROLES,
  careerConfigUpdateSchema,
  careerLevelRequestSchema,
  leadRoutingOutputSchema,
  leadReviewOutputSchema,
  type CareerProfile,
  type CareerConfig,
  type CareerChange,
  type CareerReview,
  type CareerSnapshot,
  type CareerFilters,
  type WorkflowLink,
  type RatingAggregate,
  type Difficulty,
} from "../../../src/shared/career.ts";
import { ApprovalEngine } from "../policy/approval-policy.ts";
import { ApprovalReviewStore } from "./approval-review-store.ts";
import { appendAuditEvent } from "./audit.ts";
import { newId } from "./ids.ts";
import { allRows, oneRow } from "./sql.ts";
import { redact } from "../security/redaction.ts";
export class CareerError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 409,
  ) {
    super(message);
  }
}
interface Agent {
  id: string;
  department_id: string | null;
  professional_role: string;
  key: string;
}
interface Task {
  id: string;
  company_id: string;
  assigned_agent_id: string | null;
  risk_level: string;
  sensitive: number;
  status: string;
}
interface WorkRun {
  id: string;
  task_id: string;
  agent_id: string | null;
  status: string;
  runtime_type: string;
  model: string | null;
  routing_vessel_id: string | null;
  created_at: number;
  ended_at: number | null;
}
const linkSelect = `SELECT id,company_id AS companyId,purpose,task_id AS taskId,work_run_id AS workRunId,internal_task_id AS internalTaskId,lead_agent_id AS leadAgentId,reviewer_agent_id AS reviewerAgentId,revision,status,difficulty,run_id AS runId,assigned_agent_id AS assignedAgentId,rationale FROM crew_career_workflows`;
export class CareerReviewStore {
  constructor(private readonly db: DatabaseSync) {}
  private atomic<T>(fn: () => T): T {
    this.db.exec("SAVEPOINT career_write");
    try {
      const result = fn();
      this.db.exec("RELEASE career_write");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK TO career_write; RELEASE career_write");
      throw error;
    }
  }
  private audit(
    companyId: string,
    actorId: string,
    action: string,
    id: string,
    details: Record<string, unknown>,
    owner = false,
  ) {
    appendAuditEvent(this.db, {
      companyId,
      actorId,
      actorType: owner ? "owner" : "agent",
      action,
      entityType: "career",
      entityId: id,
      details,
    });
  }
  private owner(actorId: string) {
    const u = oneRow<{ role: string; status: string }>(
      this.db.prepare("SELECT role,status FROM crew_users WHERE id=?"),
      actorId,
    );
    if (u?.role === "owner" && u.status === "active") return;
    const n = oneRow<{ n: number }>(this.db.prepare("SELECT COUNT(*) AS n FROM crew_users"))!.n;
    if (n === 0 && actorId === "ceo") return;
    throw new CareerError("owner_required", "Nur aktive Owner dürfen Personalrichtlinien ändern.", 403);
  }
  private agent(c: string, id: string): Agent {
    const a = oneRow<Agent>(
      this.db.prepare(
        "SELECT a.id,a.department_id,a.key,t.professional_role FROM crew_agents a JOIN crew_talents t ON t.id=a.talent_id WHERE a.company_id=? AND a.id=?",
      ),
      c,
      id,
    );
    if (!a) throw new CareerError("agent_scope", "Agent gehört nicht zur Firma.", 403);
    return a;
  }
  private task(c: string, id: string): Task {
    const t = oneRow<Task>(this.db.prepare("SELECT * FROM crew_tasks WHERE company_id=? AND id=?"), c, id);
    if (!t) throw new CareerError("task_scope", "Aufgabe gehört nicht zur Firma.", 403);
    return t;
  }
  private run(c: string, id: string): WorkRun {
    const r = oneRow<WorkRun>(this.db.prepare("SELECT * FROM crew_runs WHERE company_id=? AND id=?"), c, id);
    if (!r || r.status !== "completed")
      throw new CareerError("run_evidence", "Abgeschlossener Run als Nachweis erforderlich.");
    return r;
  }
  config(c: string): CareerConfig {
    const row = oneRow<{ config_json: string }>(
      this.db.prepare("SELECT config_json FROM crew_career_config WHERE company_id=? ORDER BY revision DESC LIMIT 1"),
      c,
    );
    return row ? (JSON.parse(row.config_json) as CareerConfig) : { revision: 0, enabled: false, departments: [] };
  }
  isEnabled(c: string) {
    return this.config(c).enabled;
  }
  /** Explicit activation snapshot, independent of clocks or SQLite rowid reuse. */
  appliesToTask(c: string, taskId: string): boolean {
    this.task(c, taskId);
    if (this.db.prepare("SELECT id FROM crew_career_workflows WHERE company_id=? AND task_id=? LIMIT 1").get(c, taskId))
      return true;
    return !this.db
      .prepare("SELECT task_id FROM crew_career_legacy_tasks WHERE company_id=? AND task_id=?")
      .get(c, taskId);
  }
  departmentPolicy(c: string, id: string | null) {
    return this.config(c).departments.find((d) => d.departmentId === id) ?? null;
  }
  forAgent(c: string, id: string): CareerProfile {
    this.agent(c, id);
    return (
      oneRow<CareerProfile>(
        this.db.prepare(
          "SELECT agent_id AS agentId,level,revision FROM crew_career_levels WHERE company_id=? AND agent_id=? ORDER BY revision DESC LIMIT 1",
        ),
        c,
        id,
      ) ?? { agentId: id, level: "senior", revision: 0 }
    );
  }
  updateConfig(c: string, input: unknown, actor: string): CareerConfig {
    return this.atomic(() => {
      this.owner(actor);
      const p = careerConfigUpdateSchema.parse(input);
      if (this.config(c).revision !== p.baseRevision)
        throw new CareerError("stale_revision", "Konfiguration wurde geändert. Bitte neu laden.");
      const ids = new Set<string>();
      for (const d of p.departments) {
        if (
          ids.has(d.departmentId) ||
          !this.db.prepare("SELECT id FROM crew_departments WHERE company_id=? AND id=?").get(c, d.departmentId)
        )
          throw new CareerError("department_scope", "Ungültige oder doppelte Abteilung.", 403);
        ids.add(d.departmentId);
        if (d.leadAgentId) {
          const a = this.agent(c, d.leadAgentId);
          if (a.department_id !== d.departmentId || this.forAgent(c, a.id).level !== "lead")
            throw new CareerError(
              "lead_required",
              "Abteilungsleitung benötigt genehmigten Lead-Level und passende Abteilung.",
            );
        }
        if (d.enabled && !d.leadAgentId) throw new CareerError("lead_required", "Aktive Abteilung benötigt Leitung.");
        if (d.fallbackReviewerAgentId) this.assertFallback(c, d.fallbackReviewerAgentId);
      }
      const previous = this.config(c);
      if (p.enabled)
        for (const department of p.departments.filter((d) => d.enabled)) {
          if (
            !previous.enabled ||
            !previous.departments.some((d) => d.departmentId === department.departmentId && d.enabled)
          )
            this.db
              .prepare(
                `INSERT OR IGNORE INTO crew_career_legacy_tasks(company_id,task_id) SELECT t.company_id,t.id FROM crew_tasks t JOIN crew_agents a ON a.id=t.assigned_agent_id AND a.company_id=t.company_id WHERE t.company_id=? AND a.department_id=?`,
              )
              .run(c, department.departmentId);
        }
      const config = { revision: p.baseRevision + 1, enabled: p.enabled, departments: p.departments };
      this.db
        .prepare("INSERT INTO crew_career_config VALUES (?,?,?,?,?)")
        .run(c, config.revision, JSON.stringify(config), actor, Date.now());
      this.audit(c, actor, "career.config_updated", c, { revision: config.revision }, true);
      return config;
    });
  }
  requestLevel(c: string, agentId: string, input: unknown, actor: string) {
    return this.atomic(() => {
      this.owner(actor);
      const p = careerLevelRequestSchema.parse(input);
      if (this.forAgent(c, agentId).revision !== p.baseRevision)
        throw new CareerError("stale_revision", "Mitarbeiterlevel wurde geändert.");
      const id = newId("chg");
      const action = JSON.stringify({
        type: "career_level",
        version: 1,
        companyId: c,
        agentId,
        level: p.level,
        baseRevision: p.baseRevision,
        changeId: id,
      });
      const approval = new ApprovalEngine(this.db).request(c, {
        approvalType: "agent_lifecycle_change",
        requestedBy: actor,
        summary: `Mitarbeiterlevel ändern: ${p.level}`,
        riskLevel: "high",
        impact: redact(p.reason).text,
        proposedAction: action,
        expiresAt: Date.now() + 86400000,
      });
      this.db
        .prepare("INSERT INTO crew_career_changes VALUES (?,?,?,?,?,?,?)")
        .run(id, c, agentId, p.baseRevision, p.level, approval.id, "pending");
      this.audit(
        c,
        actor,
        "career.level_requested",
        agentId,
        { changeId: id, approvalId: approval.id, level: p.level },
        true,
      );
      return {
        change: {
          id,
          agentId,
          level: p.level,
          baseRevision: p.baseRevision,
          approvalId: approval.id,
          status: "pending",
        } satisfies CareerChange,
        approval,
      };
    });
  }
  settleApproval(c: string, approvalId: string): CareerProfile | null {
    return this.atomic(() => {
      const change = oneRow<CareerChange>(
        this.db.prepare(
          "SELECT id,agent_id AS agentId,level,base_revision AS baseRevision,approval_id AS approvalId,status FROM crew_career_changes WHERE company_id=? AND approval_id=?",
        ),
        c,
        approvalId,
      );
      if (!change) return null;
      if (change.status === "applied") return this.forAgent(c, change.agentId);
      const a = new ApprovalEngine(this.db).get(approvalId);
      if (!a || a.company_id !== c) return null;
      if (["rejected", "expired", "cancelled"].includes(a.status)) {
        this.db.prepare("UPDATE crew_career_changes SET status=? WHERE id=?").run(a.status, change.id);
        return null;
      }
      if (
        a.status !== "approved" ||
        a.approval_type !== "agent_lifecycle_change" ||
        !a.decided_by ||
        (a.expires_at !== null && a.expires_at <= Date.now())
      )
        return null;
      this.owner(a.decided_by);
      const tally = new ApprovalReviewStore(this.db).tally(approvalId);
      if (!tally.satisfied || tally.blocked) return null;
      const expected = {
        type: "career_level",
        version: 1,
        companyId: c,
        agentId: change.agentId,
        level: change.level,
        baseRevision: change.baseRevision,
        changeId: change.id,
      };
      if (a.proposed_action !== JSON.stringify(expected))
        throw new CareerError("approval_binding", "Freigabe stimmt nicht mit Leveländerung überein.", 403);
      if (this.forAgent(c, change.agentId).revision !== change.baseRevision) {
        this.db.prepare("UPDATE crew_career_changes SET status='stale' WHERE id=?").run(change.id);
        return null;
      }
      this.db
        .prepare("INSERT INTO crew_career_levels VALUES (?,?,?,?,?,?)")
        .run(c, change.agentId, change.baseRevision + 1, change.level, approvalId, Date.now());
      this.db.prepare("UPDATE crew_career_changes SET status='applied' WHERE id=?").run(change.id);
      this.audit(
        c,
        a.decided_by,
        "career.level_applied",
        change.agentId,
        { approvalId, level: change.level, revision: change.baseRevision + 1 },
        true,
      );
      return this.forAgent(c, change.agentId);
    });
  }
  private assertFallback(c: string, id: string) {
    const a = this.agent(c, id);
    if (!(CAREER_FALLBACK_REVIEWER_ROLES as readonly string[]).includes(a.professional_role))
      throw new CareerError("reviewer_role", "Ersatzreview benötigt explizite QA-/COO-Rolle.", 403);
  }
  private assertReviewer(c: string, work: WorkRun, reviewerId: string) {
    if (!work.agent_id || work.agent_id === reviewerId)
      throw new CareerError("self_review", "Selbstbewertung ist nicht erlaubt.", 403);
    const worker = this.agent(c, work.agent_id);
    this.agent(c, reviewerId);
    const p = this.departmentPolicy(c, worker.department_id);
    if (!this.isEnabled(c) || !p?.enabled || !p.leadAgentId || this.forAgent(c, p.leadAgentId).level !== "lead")
      throw new CareerError("review_policy", "Aktive Abteilungsleitung erforderlich.");
    const lead = this.agent(c, p.leadAgentId);
    if (lead.department_id !== worker.department_id)
      throw new CareerError("review_policy", "Leitung wurde einer anderen Abteilung zugeordnet.");
    if (work.agent_id === p.leadAgentId) {
      if (p.fallbackReviewerAgentId !== reviewerId)
        throw new CareerError("reviewer_scope", "Expliziter neutraler Ersatzreviewer erforderlich.", 403);
      this.assertFallback(c, reviewerId);
    } else if (reviewerId !== p.leadAgentId)
      throw new CareerError("reviewer_scope", "Nur die aktuelle Abteilungsleitung darf bewerten.", 403);
  }
  internalForTask(c: string, id: string) {
    return oneRow<WorkflowLink>(this.db.prepare(`${linkSelect} WHERE company_id=? AND internal_task_id=?`), c, id);
  }
  routingForTask(c: string, id: string) {
    return oneRow<WorkflowLink>(
      this.db.prepare(
        `${linkSelect} WHERE company_id=? AND task_id=? AND purpose='routing' ORDER BY revision DESC LIMIT 1`,
      ),
      c,
      id,
    );
  }
  reviewForRun(c: string, id: string) {
    return oneRow<WorkflowLink>(
      this.db.prepare(`${linkSelect} WHERE company_id=? AND work_run_id=? AND purpose='review'`),
      c,
      id,
    );
  }
  private link(c: string, id: string) {
    const l = oneRow<WorkflowLink>(this.db.prepare(`${linkSelect} WHERE company_id=? AND id=?`), c, id);
    if (!l) throw new CareerError("workflow_scope", "Workflow gehört nicht zur Firma.", 403);
    return l;
  }
  createRouting(
    c: string,
    p: { taskId: string; internalTaskId: string; leadAgentId: string; revision?: number },
  ): WorkflowLink {
    return this.atomic(() => {
      const task = this.task(c, p.taskId);
      const internal = this.task(c, p.internalTaskId);
      const lead = this.agent(c, p.leadAgentId);
      const policy = this.departmentPolicy(c, lead.department_id);
      if (!task.assigned_agent_id || this.agent(c, task.assigned_agent_id).department_id !== lead.department_id)
        throw new CareerError("routing_scope", "Leitung gehört nicht zur Abteilung der Aufgabe.", 403);
      if (
        !this.isEnabled(c) ||
        !policy?.enabled ||
        policy.leadAgentId !== lead.id ||
        this.forAgent(c, lead.id).level !== "lead" ||
        internal.assigned_agent_id !== lead.id ||
        task.id === internal.id
      )
        throw new CareerError("routing_scope", "Aktive Leitung und eigene Routingaufgabe erforderlich.");
      const previous = this.routingForTask(c, p.taskId);
      if (previous?.status === "pending") return previous;
      const revision = (previous?.revision ?? 0) + 1;
      if (p.revision !== undefined && p.revision !== revision)
        throw new CareerError("stale_revision", "Routingrevision wurde geändert.");
      const id = newId("action");
      this.db
        .prepare(
          "INSERT INTO crew_career_workflows(id,company_id,purpose,task_id,internal_task_id,lead_agent_id,revision,status,created_at) VALUES (?,?,'routing',?,?,?,?,'pending',?)",
        )
        .run(id, c, p.taskId, p.internalTaskId, p.leadAgentId, revision, Date.now());
      this.audit(c, lead.id, "career.routing_created", id, { taskId: task.id, internalTaskId: internal.id, revision });
      return this.link(c, id);
    });
  }
  completeRouting(
    c: string,
    id: string,
    p: { runId: string; assignedAgentId: string; difficulty: Difficulty; rationale: string },
  ): WorkflowLink {
    return this.atomic(() => {
      const l = this.link(c, id);
      if (l.purpose !== "routing" || l.status !== "pending")
        throw new CareerError("stale_workflow", "Routing wurde bereits abgeschlossen.");
      const parsed = leadRoutingOutputSchema.parse({
        version: 1,
        assignedAgentId: p.assignedAgentId,
        difficulty: p.difficulty,
        rationale: p.rationale,
      });
      const r = this.run(c, p.runId);
      if (r.task_id !== l.internalTaskId || r.agent_id !== l.leadAgentId)
        throw new CareerError("run_evidence", "Routingnachweis gehört nicht zur Leitung.");
      const a = this.agent(c, parsed.assignedAgentId);
      const lead = this.agent(c, l.leadAgentId!);
      const policy = this.departmentPolicy(c, lead.department_id);
      const task = this.task(c, l.taskId);
      if (!task.assigned_agent_id || this.agent(c, task.assigned_agent_id).department_id !== lead.department_id)
        throw new CareerError("routing_scope", "Aufgabenzuständigkeit wurde geändert.", 403);
      if (
        !this.isEnabled(c) ||
        !policy?.enabled ||
        policy.leadAgentId !== lead.id ||
        this.forAgent(c, lead.id).level !== "lead" ||
        a.department_id !== lead.department_id
      )
        throw new CareerError("routing_scope", "Delegation ist außerhalb der aktuellen Abteilungsrichtlinie.", 403);
      if (
        this.forAgent(c, a.id).level === "junior" &&
        (parsed.difficulty !== "simple" || task.risk_level !== "low" || task.sensitive !== 0)
      )
        throw new CareerError(
          "junior_scope",
          "Junior darf nur einfache, risikoarme, nicht sensible Aufgaben erhalten.",
          403,
        );
      this.db
        .prepare(
          "UPDATE crew_career_workflows SET status='completed',run_id=?,assigned_agent_id=?,difficulty=?,rationale=? WHERE id=?",
        )
        .run(p.runId, a.id, parsed.difficulty, redact(parsed.rationale).text, id);
      this.audit(c, lead.id, "career.routing_completed", id, {
        taskId: l.taskId,
        runId: r.id,
        assignedAgentId: a.id,
        difficulty: parsed.difficulty,
      });
      return this.link(c, id);
    });
  }
  createReview(
    c: string,
    p: {
      workTaskId: string;
      workRunId: string;
      internalTaskId: string | null;
      reviewerAgentId: string | null;
      difficulty: Difficulty;
    },
  ): WorkflowLink {
    return this.atomic(() => {
      this.task(c, p.workTaskId);
      const w = this.run(c, p.workRunId);
      if (w.task_id !== p.workTaskId || !w.agent_id)
        throw new CareerError("run_evidence", "Arbeitsrun passt nicht zur Aufgabe.");
      const prior = this.reviewForRun(c, w.id);
      if (prior) return prior;
      if (p.internalTaskId && p.reviewerAgentId) {
        this.assertReviewer(c, w, p.reviewerAgentId);
        const internal = this.task(c, p.internalTaskId);
        if (internal.id === p.workTaskId || internal.assigned_agent_id !== p.reviewerAgentId)
          throw new CareerError("review_scope", "Eigene Reviewaufgabe erforderlich.");
      } else if (p.internalTaskId || p.reviewerAgentId)
        throw new CareerError("review_scope", "Unvollständige Reviewerzuordnung.");
      const revision = oneRow<{ n: number }>(
        this.db.prepare(
          "SELECT COALESCE(MAX(revision),0)+1 AS n FROM crew_career_workflows WHERE company_id=? AND task_id=? AND purpose='review'",
        ),
        c,
        p.workTaskId,
      )!.n;
      const id = newId("action");
      this.db
        .prepare(
          "INSERT INTO crew_career_workflows(id,company_id,purpose,task_id,work_run_id,internal_task_id,reviewer_agent_id,revision,status,difficulty,created_at) VALUES (?,?,'review',?,?,?,?,?,?,?,?)",
        )
        .run(
          id,
          c,
          p.workTaskId,
          w.id,
          p.internalTaskId,
          p.reviewerAgentId,
          revision,
          p.reviewerAgentId ? "pending" : "owner_required",
          p.difficulty,
          Date.now(),
        );
      this.audit(c, p.reviewerAgentId ?? w.agent_id, "career.review_created", id, {
        workRunId: w.id,
        revision,
        status: p.reviewerAgentId ? "pending" : "owner_required",
      });
      return this.link(c, id);
    });
  }
  completeReview(
    c: string,
    id: string,
    p: {
      reviewRunId: string;
      score: number;
      rationale: string;
      rubricDimensions: { correctness: number; completeness: number; quality: number };
      evidence?: string[];
    },
  ): CareerReview {
    return this.atomic(() => {
      const l = this.link(c, id);
      if (l.purpose !== "review" || l.status !== "pending" || !l.workRunId || !l.reviewerAgentId)
        throw new CareerError("stale_workflow", "Review ist nicht offen.");
      const value = leadReviewOutputSchema.parse({
        version: 1,
        score: p.score,
        rationale: p.rationale,
        rubricDimensions: p.rubricDimensions,
        evidence: p.evidence ?? [],
      });
      const work = this.run(c, l.workRunId);
      const review = this.run(c, p.reviewRunId);
      this.assertReviewer(c, work, l.reviewerAgentId);
      if (review.task_id !== l.internalTaskId || review.agent_id !== l.reviewerAgentId || review.id === work.id)
        throw new CareerError(
          "review_evidence",
          "Reviewrun stimmt nicht mit der unabhängigen Reviewaufgabe überein.",
          403,
        );
      const rid = newId("dec");
      this.db
        .prepare("INSERT INTO crew_career_reviews VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(
          rid,
          c,
          id,
          l.taskId,
          work.id,
          review.id,
          work.agent_id,
          l.reviewerAgentId,
          work.runtime_type,
          work.model,
          work.routing_vessel_id,
          l.revision,
          l.difficulty,
          value.score,
          redact(value.rationale).text,
          JSON.stringify(value.rubricDimensions),
          JSON.stringify(value.evidence.map((e) => redact(e).text)),
          Date.now(),
          1,
          review.runtime_type,
          review.model,
          review.routing_vessel_id,
        );
      this.db.prepare("UPDATE crew_career_workflows SET status='completed',run_id=? WHERE id=?").run(review.id, id);
      this.audit(c, l.reviewerAgentId, "career.review_completed", rid, {
        taskId: l.taskId,
        workRunId: work.id,
        reviewRunId: review.id,
        score: value.score,
        model: work.model,
        runtimeType: work.runtime_type,
        revision: l.revision,
      });
      return this.reviews(c).find((r) => r.id === rid)!;
    });
  }
  /** Explicit owner retry only. Completed immutable reviews can never be reopened. */
  reopenLink(c: string, id: string, actorId: string): WorkflowLink {
    return this.atomic(() => {
      this.owner(actorId);
      const link = this.link(c, id);
      if (link.status !== "failed" || !link.internalTaskId || this.task(c, link.internalTaskId).status !== "ready")
        throw new CareerError(
          "retry_not_ready",
          "Nur fehlgeschlagene Workflows mit explizit vorbereiteter Aufgabe dürfen neu gestartet werden.",
        );
      if (this.db.prepare("SELECT id FROM crew_career_reviews WHERE company_id=? AND workflow_id=?").get(c, id))
        throw new CareerError("immutable_review", "Abgeschlossene Bewertungen bleiben unveränderlich.");
      this.db.prepare("UPDATE crew_career_workflows SET status='pending',rationale='' WHERE id=?").run(id);
      this.audit(
        c,
        actorId,
        "career.workflow_reopened",
        id,
        { taskId: link.taskId, internalTaskId: link.internalTaskId },
        true,
      );
      return this.link(c, id);
    });
  }
  failLink(c: string, id: string, reason: string): WorkflowLink {
    return this.atomic(() => {
      const l = this.link(c, id);
      if (l.status === "pending") {
        this.db
          .prepare("UPDATE crew_career_workflows SET status='failed',rationale=? WHERE id=?")
          .run(redact(reason).text.slice(0, 8000), id);
        this.audit(c, l.reviewerAgentId ?? l.leadAgentId ?? "system", "career.workflow_failed", id, {
          reason: redact(reason).text.slice(0, 1000),
        });
      }
      return this.link(c, id);
    });
  }
  private reviews(c: string): CareerReview[] {
    const rows = allRows<CareerReview & { rubricJson: string; evidenceJson: string }>(
      this.db.prepare(
        `SELECT id,task_id AS taskId,work_run_id AS workRunId,review_run_id AS reviewRunId,agent_id AS agentId,reviewer_agent_id AS reviewerAgentId,runtime_type AS runtimeType,model,vessel_id AS vesselId,revision,difficulty,score,rationale,rubric_json AS rubricJson,evidence_json AS evidenceJson,created_at AS createdAt,rubric_version AS rubricVersion,reviewer_runtime_type AS reviewerRuntimeType,reviewer_model AS reviewerModel,reviewer_vessel_id AS reviewerVesselId FROM crew_career_reviews WHERE company_id=? ORDER BY revision DESC,created_at DESC`,
      ),
      c,
    );
    return rows.map(({ rubricJson, evidenceJson, ...r }) => {
      const latest = oneRow<{ id: string }>(
        this.db.prepare(
          `SELECT id FROM crew_runs WHERE company_id=? AND task_id=? AND status='completed' ORDER BY created_at DESC,rowid DESC LIMIT 1`,
        ),
        c,
        r.taskId,
      );
      return {
        ...r,
        rubricDimensions: JSON.parse(rubricJson) as CareerReview["rubricDimensions"],
        evidence: JSON.parse(evidenceJson) as string[],
        isCurrent: latest?.id === r.workRunId,
      };
    });
  }
  snapshot(c: string, filters: CareerFilters = {}): CareerSnapshot {
    const all = this.reviews(c);
    const reviews = all.filter(
      (r) =>
        (filters.from === undefined || r.createdAt >= filters.from) &&
        (filters.to === undefined || r.createdAt <= filters.to) &&
        (!filters.difficulty || r.difficulty === filters.difficulty) &&
        (!filters.model || r.model === filters.model),
    );
    const aggregate = (key: (r: CareerReview) => string): RatingAggregate[] => {
      const out = new Map<string, RatingAggregate>();
      for (const r of reviews.filter((x) => x.isCurrent)) {
        const k = key(r);
        const a = out.get(k) ?? {
          key: k,
          count: 0,
          mean: 0,
          distribution: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 },
          revisions: 0,
          complexity: { simple: 0, normal: 0, complex: 0 },
        };
        a.mean += r.score;
        a.count++;
        a.distribution[String(r.score) as "1"]++;
        a.complexity[r.difficulty]++;
        a.revisions += Math.max(0, r.revision - 1);
        out.set(k, a);
      }
      return [...out.values()].map((a) => ({ ...a, mean: a.mean / a.count }));
    };
    return {
      workflows: allRows<WorkflowLink>(this.db.prepare(`${linkSelect} WHERE company_id=? ORDER BY created_at DESC`), c),
      config: this.config(c),
      profiles: allRows<{ id: string }>(this.db.prepare("SELECT id FROM crew_agents WHERE company_id=?"), c).map((a) =>
        this.forAgent(c, a.id),
      ),
      reviews,
      aggregates: {
        agents: aggregate((r) => r.agentId),
        models: aggregate((r) => `${r.runtimeType}/${r.model ?? "(unbekannt)"}`),
      },
      pendingChanges: allRows<CareerChange>(
        this.db.prepare(
          "SELECT id,agent_id AS agentId,level,base_revision AS baseRevision,approval_id AS approvalId,status FROM crew_career_changes WHERE company_id=? AND status!='applied'",
        ),
        c,
      ),
    };
  }
}
