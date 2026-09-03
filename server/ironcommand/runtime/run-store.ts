/**
 * Iron Command OS — run + run-event persistence.
 *
 * Events are redacted on the way in, given a per-run monotonic sequence
 * number, and persisted before being broadcast. Persist-then-broadcast is
 * deliberate: a UI that shows an event the database never recorded is worse
 * than a UI that lags by a few milliseconds.
 */

import type { DatabaseSync } from "node:sqlite";
import { newId } from "../domain/ids.ts";
import { allRows } from "../domain/sql.ts";
import { redact, redactValue } from "../security/redaction.ts";
import { runStatusForEvent, type RunEvent, type RunEventType } from "./run-events.ts";

export interface RunRow {
  id: string;
  company_id: string;
  task_id: string;
  agent_id: string | null;
  project_id: string | null;
  runtime_type: string;
  model: string | null;
  permission_mode: string;
  sandbox_grant_id: string | null;
  status: string;
  correlation_id: string;
  session_ref: string | null;
  worker_id: string | null;
  heartbeat_at: number | null;
  error_message: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_micros: number;
  next_event_seq: number;
  started_at: number | null;
  ended_at: number | null;
  created_at: number;
}

export interface CreateRunInput {
  companyId: string;
  taskId: string;
  agentId?: string | null;
  projectId?: string | null;
  runtimeType: string;
  model?: string | null;
  permissionMode?: string;
  sandboxGrantId?: string | null;
  correlationId?: string;
  workerId?: string | null;
}

export class RunStore {
  constructor(private readonly db: DatabaseSync) {}

  create(input: CreateRunInput): RunRow {
    const id = newId("run");
    this.db
      .prepare(
        `INSERT INTO ic_runs
           (id, company_id, task_id, agent_id, project_id, runtime_type, model,
            permission_mode, sandbox_grant_id, status, correlation_id, worker_id)
         VALUES (?,?,?,?,?,?,?,?,?,'queued',?,?)`,
      )
      .run(
        id,
        input.companyId,
        input.taskId,
        input.agentId ?? null,
        input.projectId ?? null,
        input.runtimeType,
        input.model ?? null,
        input.permissionMode ?? "restricted",
        input.sandboxGrantId ?? null,
        input.correlationId ?? "",
        input.workerId ?? null,
      );
    return this.get(id)!;
  }

  get(id: string): RunRow | null {
    return (this.db.prepare("SELECT * FROM ic_runs WHERE id = ?").get(id) as RunRow | undefined) ?? null;
  }

  listForTask(taskId: string): RunRow[] {
    return this.db
      .prepare("SELECT * FROM ic_runs WHERE task_id = ? ORDER BY created_at ASC")
      .all(taskId) as unknown as RunRow[];
  }

  setStatus(runId: string, status: string, opts: { errorMessage?: string } = {}): void {
    const now = Date.now();
    const isTerminal = ["completed", "failed", "cancelled"].includes(status);
    this.db
      .prepare(
        `UPDATE ic_runs
            SET status = ?,
                error_message = COALESCE(?, error_message),
                started_at = COALESCE(started_at, CASE WHEN ? = 'running' THEN ? ELSE NULL END),
                ended_at = CASE WHEN ? THEN ? ELSE ended_at END
          WHERE id = ?`,
      )
      .run(
        status,
        opts.errorMessage ? redact(opts.errorMessage).text : null,
        status,
        now,
        isTerminal ? 1 : 0,
        now,
        runId,
      );
  }

  heartbeat(runId: string, now = Date.now()): void {
    this.db.prepare("UPDATE ic_runs SET heartbeat_at = ? WHERE id = ?").run(now, runId);
  }

  addUsage(runId: string, inputTokens: number, outputTokens: number, costMicros = 0): void {
    this.db
      .prepare(
        `UPDATE ic_runs
            SET input_tokens = input_tokens + ?,
                output_tokens = output_tokens + ?,
                cost_micros = cost_micros + ?
          WHERE id = ?`,
      )
      .run(inputTokens, outputTokens, costMicros, runId);
  }

  /**
   * Persist a run event.
   *
   * The sequence number is allocated with an UPDATE ... RETURNING so two
   * concurrent emitters cannot be handed the same seq; the UNIQUE(run_id, seq)
   * index is the backstop.
   */
  appendEvent(input: {
    companyId: string;
    runId: string;
    taskId: string;
    projectId?: string | null;
    agentId?: string | null;
    type: RunEventType;
    payload?: Record<string, unknown>;
    correlationId?: string;
    redactValues?: readonly string[];
  }): RunEvent {
    const seqRow = this.db
      .prepare("UPDATE ic_runs SET next_event_seq = next_event_seq + 1 WHERE id = ? RETURNING next_event_seq")
      .get(input.runId) as { next_event_seq: number } | undefined;
    if (!seqRow) throw new Error(`Cannot append event: unknown run ${input.runId}`);
    const seq = seqRow.next_event_seq - 1;

    const rawPayload = input.payload ?? {};
    const redactedPayload = redactValue(rawPayload, input.redactValues ?? []);
    // Determine whether redaction actually fired, so the event can say so.
    const probe = redact(JSON.stringify(rawPayload), input.redactValues ?? []);
    const redactionMeta = { redacted: probe.redacted, rules: probe.matchedRules };

    const id = newId("evt");
    const timestamp = Date.now();

    this.db
      .prepare(
        `INSERT INTO ic_run_events
           (id, company_id, run_id, task_id, project_id, agent_id, seq, type,
            payload_json, redacted, redaction_rules, correlation_id, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.companyId,
        input.runId,
        input.taskId,
        input.projectId ?? null,
        input.agentId ?? null,
        seq,
        input.type,
        JSON.stringify(redactedPayload),
        redactionMeta.redacted ? 1 : 0,
        JSON.stringify(redactionMeta.rules),
        input.correlationId ?? "",
        timestamp,
      );

    const implied = runStatusForEvent(input.type);
    if (implied) {
      this.setStatus(
        input.runId,
        implied,
        input.type === "run.failed"
          ? { errorMessage: String((rawPayload as { message?: unknown }).message ?? "run failed") }
          : {},
      );
    }

    return {
      eventId: id,
      companyId: input.companyId,
      projectId: input.projectId ?? null,
      taskId: input.taskId,
      runId: input.runId,
      agentId: input.agentId ?? null,
      seq,
      type: input.type,
      timestamp,
      correlationId: input.correlationId ?? "",
      payload: redactedPayload as Record<string, unknown>,
      redaction: redactionMeta,
    };
  }

  listEvents(runId: string, opts: { afterSeq?: number; limit?: number } = {}): RunEvent[] {
    const limit = Math.min(Math.max(opts.limit ?? 500, 1), 5000);
    const rows = this.db
      .prepare(`SELECT * FROM ic_run_events WHERE run_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`)
      .all(runId, opts.afterSeq ?? -1, limit) as unknown as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      eventId: r.id as string,
      companyId: r.company_id as string,
      projectId: (r.project_id as string) ?? null,
      taskId: r.task_id as string,
      runId: r.run_id as string,
      agentId: (r.agent_id as string) ?? null,
      seq: r.seq as number,
      type: r.type as RunEventType,
      timestamp: r.created_at as number,
      correlationId: r.correlation_id as string,
      payload: JSON.parse(r.payload_json as string) as Record<string, unknown>,
      redaction: {
        redacted: (r.redacted as number) === 1,
        rules: JSON.parse(r.redaction_rules as string) as string[],
      },
    }));
  }

  /** Runs that are active but whose heartbeat has gone stale. */
  findStale(companyId: string, staleAfterMs: number, now = Date.now()): RunRow[] {
    return allRows<RunRow>(
      this.db.prepare(
        `SELECT * FROM ic_runs
          WHERE company_id = ?
            AND status IN ('queued','running','waiting')
            AND COALESCE(heartbeat_at, created_at) <= ?`,
      ),
      companyId,
      now - staleAfterMs,
    );
  }
}
