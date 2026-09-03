/**
 * CEO Follow-Up Router — uses an LLM call to decide how a review follow-up
 * note should be routed: supplement the current agent, reset a pipeline phase,
 * or create a brand-new task.
 */

import type { DatabaseSync } from "node:sqlite";
import { callLlm, getFirstEnabledProvider, resolveModel } from "./llm-call.ts";
import { logger } from "../../../observability/logger.ts";

const log = logger.child({ module: "ceo-followup-router" });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FollowUpDecision = {
  decision: "supplement" | "pipeline_reset" | "new_task";
  target_agent_id?: string;
  target_department_id?: string;
  reset_from_phase?: string;
  new_task_title?: string;
  new_task_description?: string;
  reasoning: string;
};

/**
 * Minimal metrics surface used by the CEO follow-up router. Mirrors the
 * incCounter signature of MetricsCollector (see server/observability/metrics.ts)
 * so the real collector satisfies it without any wrapping. Optional —
 * callers without an active metrics pipeline can omit it.
 */
export type FollowUpRouterMetrics = {
  incCounter: (name: string, labels?: Record<string, string>) => void;
};

export type FollowUpRouterDeps = {
  db: DatabaseSync;
  appendTaskLog: (taskId: string, kind: string, message: string) => void;
  metrics?: FollowUpRouterMetrics;
};

/**
 * Reasons the CEO router did not produce a decision. The caller uses these to
 * distinguish "no provider configured" from genuine failures (timeouts, parse
 * errors) when falling back to the legacy direct-supplement path.
 */
export type RoutingFailureReason = "no_provider" | "task_not_found" | "llm_error" | "parse_error";

/**
 * Discriminated routing result. `decision: null` always carries a `reason`;
 * a successful routing carries the decision plus its source.
 */
export type RoutingResult =
  | { decision: FollowUpDecision; source: "llm" }
  | { decision: null; reason: RoutingFailureReason };

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

export function parseFollowUpDecision(raw: string): FollowUpDecision | null {
  try {
    // Strip markdown code fences if present
    let jsonStr = raw.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (fenceMatch) {
      jsonStr = fenceMatch[1].trim();
    }

    const parsed = JSON.parse(jsonStr);

    const decision = parsed.decision;
    if (!["supplement", "pipeline_reset", "new_task"].includes(decision)) {
      return null;
    }

    if (decision === "pipeline_reset") {
      if (!parsed.reset_from_phase || typeof parsed.reset_from_phase !== "string") {
        return null;
      }
    }

    if (decision === "new_task") {
      if (!parsed.new_task_title || typeof parsed.new_task_title !== "string") {
        return null;
      }
    }

    return {
      decision,
      target_agent_id: parsed.target_agent_id ?? undefined,
      target_department_id: parsed.target_department_id ?? undefined,
      reset_from_phase: parsed.reset_from_phase ?? undefined,
      new_task_title: parsed.new_task_title ?? undefined,
      new_task_description: parsed.new_task_description ?? undefined,
      reasoning: String(parsed.reasoning ?? ""),
    };
  } catch (err) {
    log.warn(
      { err, operation: "parse_ceo_routing_decision", rawLength: raw?.length },
      "cannot parse CEO routing decision JSON",
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Context collection (private)
// ---------------------------------------------------------------------------

type TaskRow = {
  id: string;
  title: string;
  description: string | null;
  department_id: string | null;
  assigned_agent_id: string | null;
  status: string;
  workflow_pack_key: string;
};

type ReviewRow = {
  normalized_note: string;
  raw_note: string;
  first_round: number;
  created_at: number;
};

type AgentRow = {
  id: string;
  name: string;
  role: string;
  department_id: string | null;
  dept_name: string | null;
  cli_provider: string | null;
};

type SubtaskRow = {
  id: string;
  title: string;
  status: string;
};

function collectFollowUpContext(db: Pick<DatabaseSync, "prepare">, taskId: string, note: string): string | null {
  // Task info
  const task = db
    .prepare(
      "SELECT id, title, description, department_id, assigned_agent_id, status, workflow_pack_key FROM tasks WHERE id = ?",
    )
    .get(taskId) as TaskRow | undefined;

  if (!task) return null;

  const descTruncated = task.description ? task.description.slice(0, 500) : "(none)";

  let ctx = `## Task\n`;
  ctx += `- **ID:** ${task.id}\n`;
  ctx += `- **Title:** ${task.title}\n`;
  ctx += `- **Description:** ${descTruncated}\n`;
  ctx += `- **Department:** ${task.department_id ?? "(none)"}\n`;
  ctx += `- **Assigned Agent:** ${task.assigned_agent_id ?? "(none)"}\n`;
  ctx += `- **Status:** ${task.status}\n`;
  ctx += `- **Pack:** ${task.workflow_pack_key}\n`;

  ctx += `\n## Follow-Up Note\n${note}\n`;

  // Review history (last 3)
  const reviews = db
    .prepare(
      `SELECT normalized_note, raw_note, first_round, created_at
       FROM review_revision_history
       WHERE task_id = ?
       ORDER BY id DESC LIMIT 3`,
    )
    .all(taskId) as ReviewRow[];

  if (reviews.length > 0) {
    ctx += `\n## Review History (last ${reviews.length})\n`;
    for (const r of reviews) {
      ctx += `- Round ${r.first_round}: ${r.raw_note}\n`;
    }
  }

  // Available agents (non-offline with cli_provider)
  const agents = db
    .prepare(
      `SELECT a.id, a.name, a.role, a.department_id, d.name AS dept_name, a.cli_provider
       FROM agents a
       LEFT JOIN departments d ON d.id = a.department_id
       WHERE a.status != 'offline' AND a.cli_provider IS NOT NULL`,
    )
    .all() as AgentRow[];

  if (agents.length > 0) {
    ctx += `\n## Available Agents\n`;
    for (const a of agents) {
      ctx += `- ${a.name} (${a.id}) — ${a.role}, dept: ${a.dept_name ?? a.department_id ?? "none"}, provider: ${a.cli_provider}\n`;
    }
  }

  // Pipeline phases (subtasks with [pipeline:*] title, excluding __input__)
  const phases = db
    .prepare(
      `SELECT id, title, status FROM subtasks
       WHERE task_id = ? AND title LIKE '[pipeline:%' AND title NOT LIKE '%__input__%'
       ORDER BY created_at ASC`,
    )
    .all(taskId) as SubtaskRow[];

  if (phases.length > 0) {
    ctx += `\n## Pipeline Phases\n`;
    for (const p of phases) {
      ctx += `- ${p.title} — ${p.status}\n`;
    }
  }

  return ctx;
}

// ---------------------------------------------------------------------------
// System prompt (private)
// ---------------------------------------------------------------------------

function buildSystemPrompt(hasPipeline: boolean): string {
  const options = [
    `- "supplement": Send a follow-up instruction to the currently assigned agent (or a different agent). Use when the feedback is minor or additive.`,
    ...(hasPipeline
      ? [
          `- "pipeline_reset": Reset the pipeline from a specific phase and re-run. Use when a particular phase produced incorrect output and downstream work should be redone. You MUST specify "reset_from_phase" with the phase id.`,
        ]
      : []),
    `- "new_task": Create a brand-new task for the feedback. Use when the feedback describes work that is fundamentally different from the original task. You MUST specify "new_task_title" and optionally "new_task_description".`,
  ];

  return `You are the CEO orchestrator of an AI agent office. Your job is to decide how to route a review follow-up note.

Given the task context and the follow-up note, decide the best routing:

${options.join("\n")}

Respond with a single JSON object (no markdown, no explanation outside JSON):

{
  "decision": "supplement" | "pipeline_reset" | "new_task",
  "target_agent_id": "(optional) agent id to route to",
  "target_department_id": "(optional) department id to route to",
  "reset_from_phase": "(required for pipeline_reset) phase id to reset from",
  "new_task_title": "(required for new_task) title for the new task",
  "new_task_description": "(optional) description for the new task",
  "reasoning": "brief explanation of your decision"
}`;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function routeFollowUpViaCeo(
  deps: FollowUpRouterDeps,
  taskId: string,
  note: string,
): Promise<RoutingResult> {
  // Local helper: emit one routing-result counter and return the result.
  // Centralising this means every return path is observable.
  const emit = (result: RoutingResult): RoutingResult => {
    const label = result.decision === null ? result.reason : result.decision.decision;
    try {
      deps.metrics?.incCounter("ceo.followup.routing", { result: label });
    } catch (metricErr) {
      // Never let an instrumentation bug break routing.
      log.warn({ err: metricErr }, "metrics.incCounter threw — ignoring");
    }
    return result;
  };

  // Provider lookup is wrapped separately so a DB hiccup here is reported as
  // llm_error (closest match) rather than swallowed as no_provider.
  let provider: ReturnType<typeof getFirstEnabledProvider>;
  try {
    provider = getFirstEnabledProvider(deps.db);
  } catch (err) {
    log.warn({ taskId, err }, "provider lookup failed");
    deps.appendTaskLog(taskId, "ceo-routing", `CEO follow-up routing error (provider lookup): ${String(err)}`);
    return emit({ decision: null, reason: "llm_error" });
  }

  if (!provider) {
    log.warn("no enabled API provider — skipping CEO follow-up routing");
    return emit({ decision: null, reason: "no_provider" });
  }

  let context: string | null;
  try {
    context = collectFollowUpContext(deps.db, taskId, note);
  } catch (err) {
    log.warn({ taskId, err }, "context collection failed");
    deps.appendTaskLog(taskId, "ceo-routing", `CEO follow-up routing error (context): ${String(err)}`);
    return emit({ decision: null, reason: "llm_error" });
  }

  if (!context) {
    log.warn({ taskId }, "could not collect follow-up context (task not found?)");
    return emit({ decision: null, reason: "task_not_found" });
  }

  // Read CEO model setting
  let response: string;
  try {
    const modelRow = deps.db.prepare("SELECT value FROM settings WHERE key = 'ceoOrchestratorModel' LIMIT 1").get() as
      | { value?: unknown }
      | undefined;
    const settingModel = String(modelRow?.value ?? "").trim();
    const model = resolveModel(provider, settingModel);

    // Detect whether pipeline phases exist
    const hasPipeline = context.includes("## Pipeline Phases");

    const systemPrompt = buildSystemPrompt(hasPipeline);
    response = await callLlm(provider, model, systemPrompt, context);
  } catch (err) {
    log.warn({ taskId, err }, "CEO follow-up routing failed");
    deps.appendTaskLog(taskId, "ceo-routing", `CEO follow-up routing error: ${String(err)}`);
    return emit({ decision: null, reason: "llm_error" });
  }

  const decision = parseFollowUpDecision(response);
  if (!decision) {
    log.warn({ taskId, response: response.slice(0, 300) }, "could not parse CEO follow-up decision");
    deps.appendTaskLog(taskId, "ceo-routing", `Failed to parse CEO follow-up decision`);
    return emit({ decision: null, reason: "parse_error" });
  }

  log.info({ taskId, decision: decision.decision, reasoning: decision.reasoning }, "CEO follow-up decision");
  deps.appendTaskLog(taskId, "ceo-routing", `CEO routed follow-up as "${decision.decision}": ${decision.reasoning}`);

  return emit({ decision, source: "llm" });
}
