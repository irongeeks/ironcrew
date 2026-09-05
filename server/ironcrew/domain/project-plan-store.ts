/** Original native implementation: runtime-generated plans, owner-approved canonical task trees. */
import type { DatabaseSync } from "node:sqlite";
import { parseProjectPlan, type ProjectPlanRecord } from "../../../src/shared/project-planning.ts";
import { newId } from "./ids.ts";
import { appendAuditEvent } from "./audit.ts";
type PlanRow = Omit<ProjectPlanRecord, "plan"> & { plan_json: string | null };
export class ProjectPlanStore {
  constructor(private readonly db: DatabaseSync) {}
  private hydrate(row: PlanRow): ProjectPlanRecord {
    const { plan_json, ...rest } = row;
    return { ...rest, plan: plan_json ? parseProjectPlan(plan_json) : null };
  }
  list(companyId: string): ProjectPlanRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM crew_project_plans WHERE company_id=? ORDER BY updated_at DESC")
        .all(companyId) as unknown as PlanRow[]
    ).map((row) => this.hydrate(row));
  }
  forTask(companyId: string, taskId: string): ProjectPlanRecord | null {
    const row = this.db
      .prepare("SELECT * FROM crew_project_plans WHERE company_id=? AND task_id=?")
      .get(companyId, taskId) as PlanRow | undefined;
    return row ? this.hydrate(row) : null;
  }
  create(companyId: string, projectId: string, taskId: string, actorId: string): ProjectPlanRecord {
    const task = this.db
      .prepare("SELECT id FROM crew_tasks WHERE company_id=? AND id=? AND project_id=?")
      .get(companyId, taskId, projectId);
    if (!task) throw new Error("Planning task must belong to the same company and project");
    const id = newId("plan");
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO crew_project_plans(id,company_id,project_id,task_id,status,created_at,updated_at) VALUES(?,?,?,?,'planning',?,?)",
      )
      .run(id, companyId, projectId, taskId, now, now);
    appendAuditEvent(this.db, {
      companyId,
      actorType: "owner",
      actorId,
      action: "project.plan_requested",
      entityType: "project_plan",
      entityId: id,
      taskId,
      details: { projectId },
    });
    return this.forTask(companyId, taskId)!;
  }
  capture(companyId: string, taskId: string, runId: string, output: string): ProjectPlanRecord {
    const existing = this.forTask(companyId, taskId);
    if (!existing || existing.status === "approved" || existing.status === "rejected")
      throw new Error("Project plan is not editable");
    const run = this.db
      .prepare("SELECT id FROM crew_runs WHERE id=? AND company_id=? AND task_id=?")
      .get(runId, companyId, taskId);
    if (!run) throw new Error("Plan evidence run does not belong to the planning task");
    let plan: string | null = null;
    let error: string | null = null;
    try {
      const parsed = parseProjectPlan(output);
      for (const task of parsed.tasks) {
        if (!this.db.prepare("SELECT id FROM crew_agents WHERE company_id=? AND key=?").get(companyId, task.agentKey))
          throw new Error(`Unknown agent: ${task.agentKey}`);
      }
      plan = JSON.stringify(parsed);
    } catch (err) {
      error = err instanceof Error ? err.message.slice(0, 3000) : "Invalid plan";
    }
    this.db
      .prepare(
        "UPDATE crew_project_plans SET plan_json=?,error=?,run_id=?,status=?,updated_at=? WHERE company_id=? AND task_id=?",
      )
      .run(plan, error, runId, error ? "failed" : "review", Date.now(), companyId, taskId);
    appendAuditEvent(this.db, {
      companyId,
      actorType: "system",
      actorId: "orchestrator",
      action: error ? "project.plan_invalid" : "project.plan_ready",
      entityType: "project_plan",
      entityId: existing.id,
      taskId,
      details: { runId },
      outcome: error ? "failed" : "ok",
    });
    return this.forTask(companyId, taskId)!;
  }
  markReviewed(companyId: string, taskId: string, decision: "approved" | "rejected", actorId: string): void {
    const result = this.db
      .prepare(
        "UPDATE crew_project_plans SET status=?,reviewed_by=?,updated_at=? WHERE company_id=? AND task_id=? AND status='review'",
      )
      .run(decision, actorId, Date.now(), companyId, taskId);
    if (!result.changes) throw new Error("Project plan is not awaiting review");
    appendAuditEvent(this.db, {
      companyId,
      actorType: "owner",
      actorId,
      action: `project.plan_${decision}`,
      entityType: "project_plan",
      entityId: this.forTask(companyId, taskId)!.id,
      taskId,
    });
  }
}
