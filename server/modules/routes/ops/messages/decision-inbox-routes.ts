import { randomUUID } from "node:crypto";
import type { RuntimeContext } from "../../../../types/runtime-context.ts";
import type { AgentRow } from "../../shared/types.ts";
import type { DecisionInboxRouteItem } from "./decision-inbox/types.ts";
import {
  createDecisionInboxMessengerBridge,
  type DecisionReplyBridgeInput,
  type DecisionReplyBridgeResult,
} from "./decision-inbox/messenger-bridge.ts";
import { handleProjectReviewDecisionReply } from "./decision-inbox/project-review-reply.ts";
import { handleReviewRoundDecisionReply } from "./decision-inbox/review-round-reply.ts";
import { handleTimeoutResumeDecisionReply } from "./decision-inbox/timeout-reply.ts";
import { createProjectAndTimeoutDecisionItems } from "./decision-inbox/project-timeout-items.ts";
import { createReviewRoundDecisionItems } from "./decision-inbox/review-round-items.ts";
import { createDecisionStateHelpers } from "./decision-inbox/state-helpers.ts";
import { createProjectReviewPlanningHelpers } from "./decision-inbox/project-review-planning.ts";
import { createReviewRoundPlanningHelpers } from "./decision-inbox/review-round-planning.ts";
import { readYoloModeEnabled, runYoloDecisionAutopilot } from "./decision-inbox/yolo-mode.ts";
import { routeFollowUpViaCeo } from "../../../../modules/workflow/orchestration/ceo-followup-router.ts";
import { logger } from "../../../../observability/logger.ts";

const log = logger.child({ module: "ops" });

export type { DecisionReplyBridgeInput, DecisionReplyBridgeResult };

export type DecisionInboxRouteBridge = {
  tryHandleInboxDecisionReply: (input: DecisionReplyBridgeInput) => Promise<DecisionReplyBridgeResult>;
};

export function registerDecisionInboxRoutes(ctx: RuntimeContext): DecisionInboxRouteBridge {
  const __ctx: RuntimeContext = ctx;
  const {
    app,
    db,
    nowMs,
    activeProcesses,
    appendTaskLog,
    broadcast,
    finishReview,
    getAgentDisplayName,
    getDeptName,
    getPreferredLanguage,
    l,
    pickL,
    findTeamLeader,
    normalizeTextField,
    processSubtaskDelegations,
    resolveLang,
    runAgentOneShot,
    scheduleNextReviewRound,
    seedReviewRevisionSubtasks,
    startTaskExecutionForAgent,
    chooseSafeReply,
    runTask,
  } = __ctx;

  const PROJECT_REVIEW_TASK_SELECTED_LOG_PREFIX = "Decision inbox: project review task option selected";
  const REVIEW_DECISION_RESOLVED_LOG_PREFIX = "Decision inbox: review decision resolved";

  const {
    buildProjectReviewSnapshotHash,
    getProjectReviewDecisionState,
    upsertProjectReviewDecisionState,
    buildReviewRoundSnapshotHash,
    getReviewRoundDecisionState,
    upsertReviewRoundDecisionState,
    recordProjectReviewDecisionEvent,
  } = createDecisionStateHelpers({ db, nowMs });

  const { formatPlannerSummaryForDisplay, resolvePlanningLeadMeta, queueProjectReviewPlanningConsolidation } =
    createProjectReviewPlanningHelpers({
      db,
      nowMs,
      l: l as any,
      pickL: pickL as any,
      findTeamLeader: findTeamLeader as any,
      runAgentOneShot: runAgentOneShot as any,
      chooseSafeReply: chooseSafeReply as any,
      getAgentDisplayName,
      getProjectReviewDecisionState,
      recordProjectReviewDecisionEvent,
      packRegistry: __ctx.packRegistry ?? null,
      taskWorktrees: __ctx.taskWorktrees,
    });

  const { queueReviewRoundPlanningConsolidation } = createReviewRoundPlanningHelpers({
    db,
    nowMs,
    l: l as any,
    pickL: pickL as any,
    findTeamLeader: findTeamLeader as any,
    runAgentOneShot: runAgentOneShot as any,
    chooseSafeReply: chooseSafeReply as any,
    getAgentDisplayName,
    getReviewRoundDecisionState,
    formatPlannerSummaryForDisplay,
    recordProjectReviewDecisionEvent,
    getProjectReviewDecisionState,
  });

  const { getProjectReviewTaskChoices, buildProjectReviewDecisionItems, buildTimeoutResumeDecisionItems } =
    createProjectAndTimeoutDecisionItems({
      db,
      nowMs,
      getPreferredLanguage,
      pickL: pickL as any,
      l: l as any,
      buildProjectReviewSnapshotHash,
      getProjectReviewDecisionState,
      upsertProjectReviewDecisionState,
      resolvePlanningLeadMeta,
      formatPlannerSummaryForDisplay,
      queueProjectReviewPlanningConsolidation,
      PROJECT_REVIEW_TASK_SELECTED_LOG_PREFIX,
    });

  const { getReviewDecisionFallbackLabel, getReviewDecisionNotes, buildReviewRoundDecisionItems } =
    createReviewRoundDecisionItems({
      db,
      nowMs,
      getPreferredLanguage,
      pickL: pickL as any,
      l: l as any,
      buildReviewRoundSnapshotHash,
      getReviewRoundDecisionState,
      upsertReviewRoundDecisionState,
      resolvePlanningLeadMeta,
      formatPlannerSummaryForDisplay,
      queueReviewRoundPlanningConsolidation,
    });

  async function openSupplementRound(
    taskId: string,
    assignedAgentId: string | null,
    fallbackDepartmentId: string | null,
    logPrefix = "Decision inbox",
    followUpNote?: string,
  ): Promise<{ started: boolean; reason: string }> {
    let resolvedAgentId = assignedAgentId;
    let resolvedDeptId = fallbackDepartmentId;

    // --- CEO follow-up routing ---
    if (followUpNote) {
      const routing = await routeFollowUpViaCeo({ db, appendTaskLog, metrics: __ctx.metrics }, taskId, followUpNote);

      if (routing.decision === null) {
        // Fall back to legacy direct-supplement path. Record the reason so
        // operators have a trail for "why did the CEO not route this?".
        appendTaskLog(
          taskId,
          "system",
          `${logPrefix}: CEO follow-up routing skipped (reason: ${routing.reason}); falling back to direct supplement`,
        );
      }

      const decision = routing.decision;
      if (decision) {
        // --- pipeline_reset ---
        if (decision.decision === "pipeline_reset" && decision.reset_from_phase) {
          // Stop any active process
          if (activeProcesses.has(taskId)) {
            const proc = activeProcesses.get(taskId);
            if (proc && typeof (proc as { kill?: unknown }).kill === "function") (proc as { kill: () => void }).kill();
            activeProcesses.delete(taskId);
          }

          // Reset phases using graph topology
          const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as
            | { workflow_pack_key?: string | null }
            | undefined;
          if (!task?.workflow_pack_key || !__ctx.packRegistry) {
            appendTaskLog(
              taskId,
              "system",
              `${logPrefix}: CEO routed to pipeline_reset but pack registry unavailable, falling back to supplement`,
            );
            // fall through to supplement round
          } else {
            const registryPack = __ctx.packRegistry.get(task.workflow_pack_key);
            if (!registryPack) {
              appendTaskLog(
                taskId,
                "system",
                `${logPrefix}: CEO routed to pipeline_reset but pack registry unavailable, falling back to supplement`,
              );
              // fall through to supplement round
            } else {
              const basePhaseId = decision.reset_from_phase.includes(":")
                ? decision.reset_from_phase.split(":")[0]
                : decision.reset_from_phase;
              const downstreamPhaseIds = new Set<string>();
              const adjacency = registryPack.graph.adjacency as Map<string, string[]>;
              const queue = [basePhaseId];
              downstreamPhaseIds.add(basePhaseId);
              while (queue.length > 0) {
                const current = queue.shift()!;
                const children = adjacency.get(current) ?? [];
                for (const child of children) {
                  if (!downstreamPhaseIds.has(child)) {
                    downstreamPhaseIds.add(child);
                    queue.push(child);
                  }
                }
              }

              const allPipelineSubtasks = db
                .prepare(
                  "SELECT id, title, status FROM subtasks WHERE task_id = ? AND title LIKE '[pipeline:%' AND title != '[pipeline:__input__]'",
                )
                .all(taskId) as Array<{ id: string; title: string; status: string }>;

              for (const sub of allPipelineSubtasks) {
                const match = sub.title.match(/\[pipeline:([^\]]+)\]/);
                if (!match) continue;
                const subBaseId = match[1].includes(":") ? match[1].split(":")[0] : match[1];
                if (!downstreamPhaseIds.has(subBaseId)) continue;
                const newStatus = subBaseId === basePhaseId ? "pending" : "blocked";
                db.prepare("UPDATE subtasks SET status = ?, completed_at = NULL WHERE id = ?").run(newStatus, sub.id);
                const updated = db.prepare("SELECT * FROM subtasks WHERE id = ?").get(sub.id);
                broadcast("subtask_update", updated);
              }

              appendTaskLog(
                taskId,
                "system",
                `${logPrefix}: CEO routed to pipeline_reset from '${decision.reset_from_phase}' (${downstreamPhaseIds.size} phases reset)`,
              );

              // Set task to planned for graph-runner to pick up
              const branchTs = nowMs();
              db.prepare("UPDATE tasks SET status = 'planned', updated_at = ? WHERE id = ?").run(branchTs, taskId);
              const updatedTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
              broadcast("task_update", updatedTask);
              return { started: true, reason: "pipeline_reset" };
            }
          }
        }

        // --- new_task ---
        if (decision.decision === "new_task") {
          const branchTs = nowMs();
          const newTaskId = randomUUID();
          const newTitle = decision.new_task_title ?? followUpNote.slice(0, 72);
          const newDesc = decision.new_task_description ?? followUpNote;

          const origTask = db
            .prepare("SELECT project_id, project_path, workflow_pack_key FROM tasks WHERE id = ?")
            .get(taskId) as
            | { project_id: string | null; project_path: string | null; workflow_pack_key: string | null }
            | undefined;

          db.prepare(
            `INSERT INTO tasks (id, title, description, department_id, status, priority,
             workflow_pack_key, project_id, project_path, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'inbox', 5, ?, ?, ?, ?, ?)`,
          ).run(
            newTaskId,
            newTitle,
            newDesc,
            decision.target_department_id ?? null,
            origTask?.workflow_pack_key ?? null,
            origTask?.project_id ?? null,
            origTask?.project_path ?? null,
            branchTs,
            branchTs,
          );

          appendTaskLog(
            taskId,
            "system",
            `${logPrefix}: CEO created new task '${newTitle}' [${newTaskId.slice(0, 8)}]`,
          );
          appendTaskLog(
            newTaskId,
            "system",
            `Task created via CEO follow-up routing (origin: task ${taskId.slice(0, 8)}, note: ${followUpNote.slice(0, 120)})`,
          );

          const newTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(newTaskId);
          broadcast("task_update", newTask);
          return { started: true, reason: "new_task" };
        }

        // --- supplement with potential re-routing ---
        if (decision.target_agent_id) {
          resolvedAgentId = decision.target_agent_id;
          appendTaskLog(
            taskId,
            "system",
            `${logPrefix}: CEO re-routed to agent ${decision.target_agent_id.slice(0, 8)} (${decision.reasoning})`,
          );
        }
        if (decision.target_department_id) {
          resolvedDeptId = decision.target_department_id;
        }
      }
      // decision === null -> fallback to original agent
    }

    // --- Validate CEO-selected agent before persisting ---
    if (resolvedAgentId && resolvedAgentId !== assignedAgentId) {
      const candidateAgent = db.prepare("SELECT * FROM agents WHERE id = ?").get(resolvedAgentId) as
        | AgentRow
        | undefined;
      if (!candidateAgent || candidateAgent.status === "offline") {
        appendTaskLog(
          taskId,
          "system",
          `${logPrefix}: CEO-selected agent ${resolvedAgentId.slice(0, 8)} is ${!candidateAgent ? "not found" : "offline"}, reverting to original agent`,
        );
        resolvedAgentId = assignedAgentId;
        resolvedDeptId = fallbackDepartmentId;
      }
    }

    // --- Update DB if CEO re-routed to a validated different agent/department ---
    if (resolvedAgentId !== assignedAgentId || resolvedDeptId !== fallbackDepartmentId) {
      const rerouteTs = nowMs();
      if (resolvedAgentId !== assignedAgentId) {
        db.prepare("UPDATE tasks SET assigned_agent_id = ?, updated_at = ? WHERE id = ?").run(
          resolvedAgentId,
          rerouteTs,
          taskId,
        );
      }
      if (resolvedDeptId !== fallbackDepartmentId) {
        db.prepare("UPDATE tasks SET department_id = ?, updated_at = ? WHERE id = ?").run(
          resolvedDeptId,
          rerouteTs,
          taskId,
        );
      }
    }

    const branchTs = nowMs();
    db.prepare("UPDATE tasks SET status = 'pending', updated_at = ? WHERE id = ?").run(branchTs, taskId);
    const pendingTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
    broadcast("task_update", pendingTask);
    appendTaskLog(taskId, "system", `${logPrefix}: supplement round opened (review -> pending)`);

    if (!resolvedAgentId) {
      appendTaskLog(taskId, "system", `${logPrefix}: supplement round pending (no assigned agent)`);
      return { started: false, reason: "no_assignee" };
    }

    const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(resolvedAgentId) as AgentRow | undefined;
    if (!agent) {
      appendTaskLog(taskId, "system", `${logPrefix}: supplement round pending (assigned agent not found)`);
      return { started: false, reason: "agent_not_found" };
    }
    if (agent.status === "offline") {
      appendTaskLog(taskId, "system", `${logPrefix}: supplement round pending (assigned agent offline)`);
      return { started: false, reason: "agent_offline" };
    }
    if (activeProcesses.has(taskId)) {
      return { started: false, reason: "already_running" };
    }
    if (
      agent.status === "working" &&
      agent.current_task_id &&
      agent.current_task_id !== taskId &&
      activeProcesses.has(agent.current_task_id)
    ) {
      appendTaskLog(
        taskId,
        "system",
        `${logPrefix}: supplement round pending (agent busy on ${agent.current_task_id})`,
      );
      return { started: false, reason: "agent_busy" };
    }

    appendTaskLog(taskId, "system", `${logPrefix}: supplement round execution started`);
    // Use runTask (POST /api/tasks/:id/run) instead of startTaskExecutionForAgent directly.
    // This ensures the execution-run route handles pipeline phase marking, phase guidance
    // injection, and graph-runner auto-dispatch for connector phases — all of which are
    // skipped when calling startTaskExecutionForAgent directly.
    try {
      await runTask(taskId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      appendTaskLog(taskId, "system", `${logPrefix}: supplement round runTask failed: ${msg}`);
      return { started: false, reason: "run_failed" };
    }
    return { started: true, reason: "started" };
  }

  function getDecisionInboxItems(): DecisionInboxRouteItem[] {
    const items = [
      ...buildProjectReviewDecisionItems(),
      ...buildReviewRoundDecisionItems(),
      ...buildTimeoutResumeDecisionItems(),
    ];
    items.sort((a, b) => b.created_at - a.created_at);
    return items;
  }

  async function applyDecisionReply(
    decisionId: string,
    body: Record<string, unknown>,
  ): Promise<{
    status: number;
    payload: Record<string, unknown>;
  }> {
    const optionNumber = Number(body.option_number ?? body.optionNumber ?? body.option);
    if (!Number.isFinite(optionNumber)) {
      return { status: 400, payload: { error: "option_number_required" } };
    }

    const currentItem = getDecisionInboxItems().find((item) => item.id === decisionId);
    if (!currentItem) {
      return { status: 404, payload: { error: "decision_not_found" } };
    }
    const selectedOption = currentItem.options.find((option) => option.number === optionNumber);
    if (!selectedOption) {
      if (currentItem.options.length <= 0) {
        return { status: 409, payload: { error: "decision_options_not_ready", kind: currentItem.kind } };
      }
      return { status: 400, payload: { error: "option_not_found", option_number: optionNumber } };
    }

    let status = 200;
    let payload: Record<string, unknown> = { ok: true };
    const req = { body } as any;
    const res = {
      status(code: number) {
        status = code;
        return this;
      },
      json(value: Record<string, unknown>) {
        payload = value;
        return this;
      },
    } as any;

    if (
      await handleProjectReviewDecisionReply({
        req,
        res,
        currentItem,
        selectedOption,
        optionNumber,
        deps: {
          db,
          appendTaskLog,
          nowMs,
          normalizeTextField,
          getPreferredLanguage,
          pickL: pickL as any,
          l: l as any,
          broadcast,
          finishReview,
          getProjectReviewDecisionState,
          recordProjectReviewDecisionEvent,
          getProjectReviewTaskChoices,
          openSupplementRound,
          processSubtaskDelegations,
          PROJECT_REVIEW_TASK_SELECTED_LOG_PREFIX,
        },
      })
    ) {
      return { status, payload };
    }

    if (
      await handleReviewRoundDecisionReply({
        req,
        res,
        currentItem,
        selectedOption,
        optionNumber,
        deps: {
          db,
          l: l as any,
          pickL: pickL as any,
          nowMs,
          resolveLang,
          normalizeTextField,
          appendTaskLog,
          processSubtaskDelegations,
          seedReviewRevisionSubtasks,
          scheduleNextReviewRound: scheduleNextReviewRound as any,
          getProjectReviewDecisionState,
          getReviewDecisionNotes,
          getReviewDecisionFallbackLabel,
          recordProjectReviewDecisionEvent,
          openSupplementRound,
          REVIEW_DECISION_RESOLVED_LOG_PREFIX,
        },
      })
    ) {
      return { status, payload };
    }

    if (
      handleTimeoutResumeDecisionReply({
        res,
        currentItem,
        selectedOption,
        deps: {
          db,
          activeProcesses,
          getDeptName,
          appendTaskLog,
          startTaskExecutionForAgent,
        },
      })
    ) {
      return { status, payload };
    }

    return { status: 400, payload: { error: "unknown_decision_id" } };
  }

  const { tryHandleInboxDecisionReply, flushDecisionInboxMessengerNotices, startBackgroundNoticeSync } =
    createDecisionInboxMessengerBridge({
      db,
      nowMs,
      getPreferredLanguage,
      normalizeTextField,
      getDecisionInboxItems,
      applyDecisionReply,
    });

  startBackgroundNoticeSync();

  let yoloAutopilotInFlight = false;

  const runYoloAutopilot = () => {
    if (yoloAutopilotInFlight) return;
    if (!readYoloModeEnabled(db)) return;
    yoloAutopilotInFlight = true;
    void runYoloDecisionAutopilot({
      getDecisionInboxItems,
      applyDecisionReply,
      shouldSkipItem: (item) => {
        if (item.kind === "review_round_pick" && item.task_id) {
          const row = db.prepare("SELECT workflow_pack_key FROM tasks WHERE id = ? LIMIT 1").get(item.task_id) as
            | { workflow_pack_key?: string | null }
            | undefined;
          return row?.workflow_pack_key === "video_preprod";
        }
        if (item.kind === "project_review_ready" && item.project_id) {
          const recentHold = db
            .prepare(
              `
              SELECT 1
              FROM task_logs tl
              JOIN tasks t ON t.id = tl.task_id
              WHERE t.project_id = ?
                AND t.status = 'review'
                AND t.source_task_id IS NULL
                AND t.workflow_pack_key = 'video_preprod'
                AND tl.kind = 'system'
                AND tl.message LIKE 'Review hold: video artifact gate blocked approval%'
                AND tl.created_at >= ?
              ORDER BY tl.created_at DESC
              LIMIT 1
            `,
            )
            .get(item.project_id, nowMs() - 120_000);
          if (recentHold) return true;
        }

        return false;
      },
    })
      .catch((err) => {
        log.warn({ err }, "decision autopilot failed");
      })
      .finally(() => {
        yoloAutopilotInFlight = false;
      });
  };
  const yoloTimer = setInterval(runYoloAutopilot, 2500);
  (yoloTimer as NodeJS.Timeout).unref?.();
  setTimeout(runYoloAutopilot, 1200);

  // ---------------------------------------------------------------------------
  // Messages / Chat
  // ---------------------------------------------------------------------------
  app.get("/api/decision-inbox", (req, res) => {
    runYoloAutopilot();
    const forceRaw = String((req.query as Record<string, unknown>)?.force ?? "")
      .trim()
      .toLowerCase();
    const forceResend = forceRaw === "1" || forceRaw === "true" || forceRaw === "yes";
    const items = getDecisionInboxItems();
    void flushDecisionInboxMessengerNotices({ force: forceResend }).catch((err) => {
      log.warn({ err }, "on-demand notice flush failed");
    });
    res.json({ items });
  });

  app.post("/api/decision-inbox/:id/reply", async (req, res) => {
    const decisionId = String(req.params.id || "");
    const result = await applyDecisionReply(decisionId, (req.body ?? {}) as Record<string, unknown>);
    runYoloAutopilot();
    return res.status(result.status).json(result.payload);
  });

  return {
    tryHandleInboxDecisionReply,
  };
}
