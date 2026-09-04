/**
 * IronCrew — budget engine.
 *
 * Two enforcement points, following the Paperclip pattern:
 *
 *   pre-dispatch  assertRunPermitted() runs before a run starts and refuses
 *                 when any scope covering it is already at hard stop.
 *   post-spend    recordCost() re-evaluates after each cost event and raises
 *                 warning / hard-stop states.
 *
 * Money is stored in micros (1e-6 of the company currency) as INTEGER, so
 * there is no floating-point drift in accumulated spend.
 *
 * Subscription runtimes have no per-call price. Their consumption is recorded
 * as a `quota` event with cost_micros = 0 rather than a fabricated amount, so
 * a dashboard never shows an invented figure.
 */

import type { DatabaseSync } from "node:sqlite";
import { newId } from "../domain/ids.ts";
import { allRows } from "../domain/sql.ts";
import { appendAuditEvent } from "../domain/audit.ts";

export type BudgetScopeType = "company" | "agent" | "project" | "task" | "runtime" | "provider";
export type BudgetState = "ok" | "warning" | "hard_stop";

export interface BudgetRow {
  id: string;
  company_id: string;
  scope_type: BudgetScopeType;
  scope_id: string;
  window_kind: "calendar_month_utc" | "lifetime" | "day_utc";
  limit_micros: number;
  warn_percent: number;
  hard_stop: number;
  active: number;
  created_at: number;
}

export interface BudgetStatus {
  budget: BudgetRow;
  spentMicros: number;
  state: BudgetState;
  /** 0..1+, spend as a fraction of the limit. */
  utilisation: number;
}

export class BudgetExceededError extends Error {
  readonly scopeType: BudgetScopeType;
  readonly scopeId: string;
  constructor(scopeType: BudgetScopeType, scopeId: string, spent: number, limit: number) {
    super(
      `Budget hard stop for ${scopeType}${scopeId ? ` "${scopeId}"` : ""}: ` +
        `${(spent / 1e6).toFixed(2)} of ${(limit / 1e6).toFixed(2)} consumed.`,
    );
    this.name = "BudgetExceededError";
    this.scopeType = scopeType;
    this.scopeId = scopeId;
  }
}

export function monthKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export function stateFor(spentMicros: number, limitMicros: number, warnPercent: number): BudgetState {
  if (limitMicros <= 0) return "ok";
  if (spentMicros >= limitMicros) return "hard_stop";
  if (spentMicros >= Math.ceil((limitMicros * warnPercent) / 100)) return "warning";
  return "ok";
}

export interface RecordCostInput {
  companyId: string;
  runId?: string | null;
  taskId?: string | null;
  projectId?: string | null;
  agentId?: string | null;
  runtimeType?: string;
  provider?: string;
  model?: string | null;
  kind?: "usage" | "quota" | "adjustment";
  inputTokens?: number;
  outputTokens?: number;
  costMicros?: number;
  now?: number;
}

export class BudgetEngine {
  constructor(private readonly db: DatabaseSync) {}

  setBudget(input: {
    companyId: string;
    scopeType: BudgetScopeType;
    scopeId?: string;
    limitMicros: number;
    warnPercent?: number;
    hardStop?: boolean;
    windowKind?: BudgetRow["window_kind"];
  }): BudgetRow {
    const scopeId = input.scopeId ?? "";
    const windowKind = input.windowKind ?? "calendar_month_utc";
    this.db
      .prepare(
        `INSERT INTO crew_budgets
           (id, company_id, scope_type, scope_id, window_kind, limit_micros, warn_percent, hard_stop, active)
         VALUES (?,?,?,?,?,?,?,?,1)
         ON CONFLICT (company_id, scope_type, scope_id, window_kind)
         DO UPDATE SET limit_micros = excluded.limit_micros,
                       warn_percent = excluded.warn_percent,
                       hard_stop = excluded.hard_stop,
                       active = 1`,
      )
      .run(
        newId("bud"),
        input.companyId,
        input.scopeType,
        scopeId,
        windowKind,
        input.limitMicros,
        input.warnPercent ?? 80,
        input.hardStop === false ? 0 : 1,
      );

    return this.db
      .prepare(
        `SELECT * FROM crew_budgets
          WHERE company_id = ? AND scope_type = ? AND scope_id = ? AND window_kind = ?`,
      )
      .get(input.companyId, input.scopeType, scopeId, windowKind) as unknown as BudgetRow;
  }

  /** Spend observed for one budget's scope and window. */
  spentFor(budget: BudgetRow, now = Date.now()): number {
    const clauses = ["company_id = ?"];
    const params: unknown[] = [budget.company_id];

    switch (budget.scope_type) {
      case "company":
        break;
      case "agent":
        clauses.push("agent_id = ?");
        params.push(budget.scope_id);
        break;
      case "project":
        clauses.push("project_id = ?");
        params.push(budget.scope_id);
        break;
      case "task":
        clauses.push("task_id = ?");
        params.push(budget.scope_id);
        break;
      case "runtime":
        clauses.push("runtime_type = ?");
        params.push(budget.scope_id);
        break;
      case "provider":
        clauses.push("provider = ?");
        params.push(budget.scope_id);
        break;
    }

    if (budget.window_kind === "calendar_month_utc") {
      clauses.push("window_month = ?");
      params.push(monthKey(now));
    } else if (budget.window_kind === "day_utc") {
      clauses.push("window_day = ?");
      params.push(dayKey(now));
    }

    const row = this.db
      .prepare(`SELECT COALESCE(SUM(cost_micros), 0) AS total FROM crew_cost_events WHERE ${clauses.join(" AND ")}`)
      .get(...(params as never[])) as { total: number };
    return row.total;
  }

  /** All active budgets that cover the given dimensions. */
  budgetsCovering(
    companyId: string,
    dims: {
      agentId?: string | null;
      projectId?: string | null;
      taskId?: string | null;
      runtimeType?: string;
      provider?: string;
    },
  ): BudgetRow[] {
    const all = allRows<BudgetRow>(
      this.db.prepare("SELECT * FROM crew_budgets WHERE company_id = ? AND active = 1"),
      companyId,
    );

    return all.filter((b) => {
      switch (b.scope_type) {
        case "company":
          return true;
        case "agent":
          return !!dims.agentId && b.scope_id === dims.agentId;
        case "project":
          return !!dims.projectId && b.scope_id === dims.projectId;
        case "task":
          return !!dims.taskId && b.scope_id === dims.taskId;
        case "runtime":
          return !!dims.runtimeType && b.scope_id === dims.runtimeType;
        case "provider":
          return !!dims.provider && b.scope_id === dims.provider;
        default:
          return false;
      }
    });
  }

  status(
    companyId: string,
    dims: Parameters<BudgetEngine["budgetsCovering"]>[1] = {},
    now = Date.now(),
  ): BudgetStatus[] {
    return this.budgetsCovering(companyId, dims).map((budget) => {
      const spentMicros = this.spentFor(budget, now);
      return {
        budget,
        spentMicros,
        state: stateFor(spentMicros, budget.limit_micros, budget.warn_percent),
        utilisation: budget.limit_micros > 0 ? spentMicros / budget.limit_micros : 0,
      };
    });
  }

  /**
   * Pre-dispatch gate. Throws when any covering budget with hard_stop enabled
   * has already been consumed.
   */
  assertRunPermitted(
    companyId: string,
    dims: Parameters<BudgetEngine["budgetsCovering"]>[1] = {},
    now = Date.now(),
  ): void {
    for (const s of this.status(companyId, dims, now)) {
      if (s.state === "hard_stop" && s.budget.hard_stop === 1) {
        appendAuditEvent(this.db, {
          companyId,
          actorType: "system",
          actorId: "budget-engine",
          action: "budget.run_blocked",
          entityType: "budget",
          entityId: s.budget.id,
          taskId: dims.taskId ?? null,
          outcome: "denied",
          details: {
            scopeType: s.budget.scope_type,
            scopeId: s.budget.scope_id,
            spentMicros: s.spentMicros,
            limitMicros: s.budget.limit_micros,
          },
        });
        throw new BudgetExceededError(s.budget.scope_type, s.budget.scope_id, s.spentMicros, s.budget.limit_micros);
      }
    }
  }

  /**
   * Record spend and re-evaluate. Returns the budgets that changed into a
   * warning or hard-stop state as a result of this event, so the caller can
   * notify or stop work.
   */
  recordCost(input: RecordCostInput): { costEventId: string; breached: BudgetStatus[] } {
    const now = input.now ?? Date.now();
    const id = newId("cost");
    const costMicros = input.kind === "quota" ? 0 : (input.costMicros ?? 0);

    this.db
      .prepare(
        `INSERT INTO crew_cost_events
           (id, company_id, run_id, task_id, project_id, agent_id, runtime_type, provider,
            model, kind, input_tokens, output_tokens, cost_micros, window_day, window_month, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.companyId,
        input.runId ?? null,
        input.taskId ?? null,
        input.projectId ?? null,
        input.agentId ?? null,
        input.runtimeType ?? "",
        input.provider ?? "",
        input.model ?? null,
        input.kind ?? "usage",
        input.inputTokens ?? 0,
        input.outputTokens ?? 0,
        costMicros,
        dayKey(now),
        monthKey(now),
        now,
      );

    const breached = this.status(
      input.companyId,
      {
        agentId: input.agentId,
        projectId: input.projectId,
        taskId: input.taskId,
        runtimeType: input.runtimeType,
        provider: input.provider,
      },
      now,
    ).filter((s) => s.state !== "ok");

    for (const s of breached) {
      appendAuditEvent(this.db, {
        companyId: input.companyId,
        actorType: "system",
        actorId: "budget-engine",
        action: s.state === "hard_stop" ? "budget.hard_stop_reached" : "budget.warning_reached",
        entityType: "budget",
        entityId: s.budget.id,
        taskId: input.taskId ?? null,
        runId: input.runId ?? null,
        details: {
          scopeType: s.budget.scope_type,
          scopeId: s.budget.scope_id,
          spentMicros: s.spentMicros,
          limitMicros: s.budget.limit_micros,
        },
      });
    }

    return { costEventId: id, breached };
  }
}
