/**
 * CEO Orchestrator — periodically reviews inbox, creates tasks, routes work,
 * and approves reviews using a single LLM API call.
 *
 * Reads `ceoOrchestratorEnabled` from settings on every tick.
 * Uses the first enabled API provider from the DB for LLM calls.
 */

import type { DatabaseSync } from "node:sqlite";
import type { Express } from "express";
import { SESSION_AUTH_TOKEN } from "../../config/runtime.ts";
import { logger } from "../../observability/logger.ts";
import { getFirstEnabledProvider, resolveModel, callLlm } from "../workflow/orchestration/llm-call.ts";

const log = logger.child({ module: "ceo-orchestrator" });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CeoOrchestratorDeps = {
  db: DatabaseSync;
  app: Express;
  broadcast: (type: string, payload: unknown) => void;
  notifyCeo: (content: string, taskId?: string | null, messageType?: string) => void;
  appendTaskLog: (taskId: string, kind: string, message: string) => void;
  nowMs: () => number;
};

type CeoDecision =
  | { type: "create_task"; title: string; description: string; department_id?: string; priority?: number }
  | { type: "reprioritize"; task_id: string; priority: number }
  | { type: "reassign"; task_id: string; department_id: string }
  | { type: "approve_review"; task_id: string }
  | { type: "message"; content: string; receiver_type: string; receiver_id?: string };

// ---------------------------------------------------------------------------
// Setting helpers
// ---------------------------------------------------------------------------

function readCeoEnabled(db: Pick<DatabaseSync, "prepare">): boolean {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'ceoOrchestratorEnabled' LIMIT 1").get() as
    | { value?: unknown }
    | undefined;
  const text = String(row?.value ?? "")
    .trim()
    .toLowerCase();
  return ["true", "1", "yes", "on"].includes(text);
}

function readCeoModel(db: Pick<DatabaseSync, "prepare">): string {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'ceoOrchestratorModel' LIMIT 1").get() as
    | { value?: unknown }
    | undefined;
  return String(row?.value ?? "").trim();
}

// ---------------------------------------------------------------------------
// Context collection
// ---------------------------------------------------------------------------

function collectCeoContext(db: Pick<DatabaseSync, "prepare">, nowMs: number): string | null {
  // Recent unread messages (last 20, within last 10 minutes)
  const tenMinAgo = nowMs - 10 * 60 * 1000;
  const messages = db
    .prepare(
      `SELECT content, message_type, created_at FROM messages
       WHERE created_at > ? AND sender_type != 'system'
       ORDER BY created_at DESC LIMIT 20`,
    )
    .all(tenMinAgo) as Array<{ content: string; message_type: string; created_at: number }>;

  // Task queue summary
  const queueStats = db
    .prepare(
      `SELECT status, COUNT(*) as cnt FROM tasks
       WHERE status NOT IN ('done', 'cancelled')
       GROUP BY status`,
    )
    .all() as Array<{ status: string; cnt: number }>;

  // Tasks in review
  const reviewTasks = db
    .prepare(`SELECT id, title, assigned_agent_id FROM tasks WHERE status = 'review' LIMIT 10`)
    .all() as Array<{ id: string; title: string; assigned_agent_id: string | null }>;

  // Agent utilization
  const agentStats = db
    .prepare(
      `SELECT status, COUNT(*) as cnt FROM agents
       WHERE cli_provider IS NOT NULL
       GROUP BY status`,
    )
    .all() as Array<{ status: string; cnt: number }>;

  // If nothing interesting, skip
  if (messages.length === 0 && reviewTasks.length === 0 && queueStats.length <= 1) {
    return null;
  }

  const sections: string[] = [];

  if (messages.length > 0) {
    sections.push("## Recent Messages", ...messages.map((m) => `- [${m.message_type}] ${m.content.slice(0, 200)}`));
  }

  if (queueStats.length > 0) {
    sections.push("## Task Queue", ...queueStats.map((s) => `- ${s.status}: ${s.cnt}`));
  }

  if (reviewTasks.length > 0) {
    sections.push("## Tasks Awaiting Review", ...reviewTasks.map((t) => `- [${t.id.slice(0, 8)}] "${t.title}"`));
  }

  if (agentStats.length > 0) {
    sections.push("## Agent Status", ...agentStats.map((s) => `- ${s.status}: ${s.cnt}`));
  }

  // Departments
  const departments = db.prepare("SELECT id, name FROM departments ORDER BY sort_order ASC").all() as Array<{
    id: string;
    name: string;
  }>;
  if (departments.length > 0) {
    sections.push("## Departments", ...departments.map((d) => `- ${d.id}: ${d.name}`));
  }

  return sections.join("\n");
}

// ---------------------------------------------------------------------------
// Decision parsing & execution
// ---------------------------------------------------------------------------

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Decision types that require a valid UUID task_id */
const TASK_ID_REQUIRED_TYPES = new Set(["reprioritize", "reassign", "approve_review"]);

export function parseDecisions(raw: string): CeoDecision[] {
  // Extract JSON array from response (may be wrapped in markdown code blocks)
  let jsonStr = raw.trim();
  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1].trim();
  }

  // Try parsing as JSON array
  try {
    const parsed = JSON.parse(jsonStr);
    if (Array.isArray(parsed)) {
      return parsed
        .filter(
          (d: any) =>
            d &&
            typeof d === "object" &&
            typeof d.type === "string" &&
            ["create_task", "reprioritize", "reassign", "approve_review", "message"].includes(d.type),
        )
        .filter((d: any) => {
          // Validate task_id for decision types that require it
          if (TASK_ID_REQUIRED_TYPES.has(d.type)) {
            if (typeof d.task_id !== "string" || !UUID_RE.test(d.task_id)) {
              log.warn({ decisionType: d.type, taskId: d.task_id }, "dropping decision: invalid task_id");
              return false;
            }
          }
          // Validate create_task requires non-empty title
          if (d.type === "create_task") {
            if (typeof d.title !== "string" || d.title.trim().length === 0) {
              log.warn("dropping create_task decision: empty or missing title");
              return false;
            }
          }
          return true;
        }) as CeoDecision[];
    }
  } catch {
    // Not valid JSON
  }
  return [];
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export function createCeoOrchestrator(deps: CeoOrchestratorDeps) {
  const { db, app, broadcast, notifyCeo, nowMs } = deps;
  let running = false;

  function buildSystemPrompt(companyName: string): string {
    return `You are the CEO of ${companyName}. Your role is to review the current state of the company and make operational decisions.

Your responsibilities:
1. **Inbox Review**: Check recent messages for requests that should become tasks.
2. **Queue Management**: Verify priorities are correct. Reprioritize if needed.
3. **Review Approval**: Approve completed tasks that are waiting for review (only if the task title/context suggests it was successful).
4. **Bottleneck Detection**: Identify if agents are overloaded and suggest reassignments.

Respond ONLY with a JSON array of decisions. If nothing needs action, respond with \`[]\`.

Decision types:
- \`{"type": "create_task", "title": "...", "description": "...", "department_id": "dev", "priority": 5}\`
- \`{"type": "reprioritize", "task_id": "...", "priority": 8}\`
- \`{"type": "reassign", "task_id": "...", "department_id": "qa"}\`
- \`{"type": "approve_review", "task_id": "..."}\`
- \`{"type": "message", "content": "...", "receiver_type": "all"}\`

Rules:
- Be conservative. Only create tasks for clear, actionable requests.
- Only approve reviews if the task appears to have been completed successfully.
- Maximum 3 decisions per tick.
- Respond with valid JSON only. No explanations.`;
  }

  const internalHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${SESSION_AUTH_TOKEN}` };

  async function executeDecision(decision: CeoDecision): Promise<void> {
    // Guard: if decision carries a task_id, it must be a valid UUID
    if ("task_id" in decision && decision.task_id && !UUID_RE.test(decision.task_id)) {
      log.warn(
        { decisionType: decision.type, taskId: decision.task_id },
        "skipping decision execution: invalid task_id",
      );
      return;
    }

    const port = (app?.get?.("port") as number) || 8790;
    const baseUrl = `http://127.0.0.1:${port}`;

    switch (decision.type) {
      case "create_task": {
        await fetch(`${baseUrl}/api/tasks`, {
          method: "POST",
          headers: internalHeaders,
          body: JSON.stringify({
            title: decision.title,
            description: decision.description,
            department_id: decision.department_id,
            priority: decision.priority ?? 5,
          }),
        });
        notifyCeo(`[CEO] Created task: "${decision.title}"`, null, "directive");
        break;
      }
      case "reprioritize": {
        await fetch(`${baseUrl}/api/tasks/${decision.task_id}`, {
          method: "PATCH",
          headers: internalHeaders,
          body: JSON.stringify({ priority: decision.priority }),
        });
        notifyCeo(
          `[CEO] Reprioritized task ${decision.task_id.slice(0, 8)} → priority ${decision.priority}`,
          decision.task_id,
          "directive",
        );
        break;
      }
      case "reassign": {
        await fetch(`${baseUrl}/api/tasks/${decision.task_id}`, {
          method: "PATCH",
          headers: internalHeaders,
          body: JSON.stringify({ department_id: decision.department_id }),
        });
        notifyCeo(
          `[CEO] Reassigned task ${decision.task_id.slice(0, 8)} → dept ${decision.department_id}`,
          decision.task_id,
          "directive",
        );
        break;
      }
      case "approve_review": {
        await fetch(`${baseUrl}/api/tasks/${decision.task_id}`, {
          method: "PATCH",
          headers: internalHeaders,
          body: JSON.stringify({ status: "done" }),
        });
        notifyCeo(`[CEO] Approved review for task ${decision.task_id.slice(0, 8)}`, decision.task_id, "directive");
        break;
      }
      case "message": {
        await fetch(`${baseUrl}/api/messages`, {
          method: "POST",
          headers: internalHeaders,
          body: JSON.stringify({
            sender_type: "ceo",
            receiver_type: decision.receiver_type,
            receiver_id: decision.receiver_id ?? null,
            content: decision.content,
            message_type: "directive",
          }),
        });
        break;
      }
    }

    broadcast("autonomous_action", {
      action: "ceo_decision",
      task_id: "task_id" in decision ? decision.task_id : undefined,
      reason: `CEO decision: ${decision.type}${decision.type === "create_task" ? ` "${decision.title}"` : ""}`,
      timestamp: nowMs(),
    });
  }

  async function ceoTick(): Promise<void> {
    if (running) return; // prevent overlapping ticks
    if (!readCeoEnabled(db)) return;

    const provider = getFirstEnabledProvider(db);
    if (!provider) return;

    const context = collectCeoContext(db, nowMs());
    if (!context) return;

    const companyNameRow = db.prepare("SELECT value FROM settings WHERE key = 'companyName' LIMIT 1").get() as
      | { value?: string }
      | undefined;
    const companyName = companyNameRow?.value ?? "OctoOffice";
    const model = resolveModel(provider, readCeoModel(db));

    running = true;
    try {
      const response = await callLlm(provider, model, buildSystemPrompt(companyName), context);

      const decisions = parseDecisions(response).slice(0, 3); // cap at 3

      for (const decision of decisions) {
        try {
          await executeDecision(decision);
        } catch (err) {
          log.error({ err }, "failed to execute decision");
        }
      }

      if (decisions.length > 0) {
        notifyCeo(
          `[CEO Orchestrator] Executed ${decisions.length} decision(s): ${decisions.map((d) => d.type).join(", ")}`,
          null,
          "status_update",
        );
      }
    } catch (err) {
      log.error({ err }, "tick failed");
    } finally {
      running = false;
    }
  }

  return { ceoTick };
}
