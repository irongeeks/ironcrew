import fs from "node:fs";
import path from "node:path";
import { syncTaskDocsBackToVault } from "../../routes/docs/index.ts";
import { releaseServerAccess } from "./server-allocation.ts";
import { handleDeptPipelineAdvancement, handleQaBounceBack } from "./run-complete-dept-pipeline.ts";
import { handleSuccessPath } from "./run-complete-success.ts";
import { handleAutoRetry, handleHardFailure } from "./run-complete-failure.ts";
import type { PackRegistry } from "../../../packs/pack-registry.ts";
import type { GraphRunner } from "./graph-runner.ts";
import { wrapDatabaseSync } from "./graph-runner.ts";
import type { MetricsCollector } from "../../../observability/metrics.ts";
import { resolveAgentRouting } from "./agent-routing.ts";
import { selectAgentForDepartment } from "../../routes/core/tasks/execution-run-auto-assign.ts";
import { logger } from "../../../observability/logger.ts";
const log = logger.child({ module: "run-complete-handler" });

// ---------------------------------------------------------------------------
// Shared dependency types for run-complete modules
// ---------------------------------------------------------------------------

/** Minimal DB interface covering the statements used across run-complete modules. */
export interface RunCompleteDb {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { changes: number | bigint };
  };
}

/** Worktree info stored in the taskWorktrees map. */
export interface WorktreeInfo {
  worktreePath: string;
  projectPath: string;
  branchName?: string;
}

/**
 * Full dependency bag for `createRunCompleteHandler`.
 * Sub-modules (`run-complete-success`, `run-complete-failure`, `run-complete-dept-pipeline`)
 * use `Pick<RunCompleteDeps, ...>` of the subset they actually need.
 */
export interface RunCompleteDeps {
  // Core state
  activeProcesses: Map<string, { pid?: number | null }>;
  stopProgressTimer: (taskId: string) => void;
  db: RunCompleteDb;
  stopRequestedTasks: Set<string>;
  stopRequestModeByTask: Map<string, string>;
  appendTaskLog: (taskId: string, kind: string, message: string) => void;
  clearTaskWorkflowState: (taskId: string) => void;
  codexThreadToSubtask: Map<string, string>;
  nowMs: () => number;
  logsDir: string;
  broadcast: (type: string, payload: unknown) => void;
  processSubtaskDelegations: (taskId: string) => void;
  taskWorktrees: Map<string, WorktreeInfo>;
  cleanupWorktree: (projectPath: string, taskId: string) => void;

  // Agent / notification helpers
  findTeamLeader: (deptId: string | null) => Record<string, unknown> | null;
  getAgentDisplayName: (agent: Record<string, unknown>, lang: string) => string;
  pickL: (translations: string[][], lang: string) => string;
  l: (...langArrays: string[][]) => string[][];
  notifyCeo: (message: string, taskId?: string) => void;
  sendAgentMessage: (
    agent: Record<string, unknown>,
    content: string,
    kind: string,
    visibility: string,
    replyTo: string | null,
    taskId: string,
  ) => void;
  resolveLang: (text: string) => string;
  formatTaskSubtaskProgressSummary: (taskId: string, lang: string) => string;

  // Cross-department & delegation state
  crossDeptNextCallbacks: Map<string, () => void>;
  recoverCrossDeptQueueAfterMissingCallback: (taskId: string) => void;
  subtaskDelegationCallbacks: Map<string, () => void>;
  finishReview: (taskId: string, taskTitle: string) => void;
  reconcileDelegatedSubtasksAfterRun: (taskId: string, exitCode: number) => void;

  // Report / review flow
  completeTaskWithoutReview: (
    task: {
      id: string;
      title: string;
      description: string | null;
      department_id: string | null;
      source_task_id: string | null;
      assigned_agent_id: string | null;
    },
    logMessage: string,
  ) => void;
  isReportRequestTask: (task: { task_type?: string | null; description?: string | null }) => boolean;
  notifyTaskStatus: (taskId: string, title: string, status: string, lang: string) => void;
  prettyStreamJson: (raw: string) => string;
  getWorktreeDiffSummary: (projectPath: string, taskId: string) => string;
  hasVisibleDiffSummary: (diff: string) => boolean;

  // Pack / graph runner
  packRegistry?: PackRegistry;
  graphRunner?: GraphRunner;

  // Observability
  metrics?: MetricsCollector;

  // Autonomous scheduler
  autonomousSchedulerTick?: () => void;

  // Task re-run (replaces HTTP self-fetch)
  runTask: (taskId: string) => Promise<void>;
}

export function createRunCompleteHandler(deps: RunCompleteDeps) {
  const {
    activeProcesses,
    stopProgressTimer,
    db,
    stopRequestedTasks,
    stopRequestModeByTask,
    appendTaskLog,
    clearTaskWorkflowState,
    codexThreadToSubtask,
    nowMs,
    logsDir,
    broadcast,
    processSubtaskDelegations,
    taskWorktrees,
  } = deps;

  const pendingReRunTimers = new Set<ReturnType<typeof setTimeout>>();
  const pendingReRunTasks = new Set<string>();

  /**
   * Trigger a re-run of the task after a pipeline step transition or auto-retry.
   * Uses the same internal POST pattern as cross-dept delegation callbacks.
   */
  function triggerTaskReRun(taskId: string, reason: string): void {
    // Prevent duplicate re-runs for the same task
    if (pendingReRunTasks.has(taskId)) return;
    pendingReRunTasks.add(taskId);

    const timer = setTimeout(async () => {
      pendingReRunTimers.delete(timer);
      pendingReRunTasks.delete(taskId);
      try {
        await deps.runTask(taskId);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        appendTaskLog(taskId, "error", `Pipeline re-run trigger failed (${reason}): ${msg}`);
      }
    }, 2500);
    pendingReRunTimers.add(timer);
  }

  function cancelPendingReRuns(): void {
    for (const t of pendingReRunTimers) clearTimeout(t);
    pendingReRunTimers.clear();
  }

  async function handleTaskRunComplete(taskId: string, exitCode: number): Promise<void> {
    activeProcesses.delete(taskId);
    stopProgressTimer(taskId);
    // Observability: record task run completion metric
    deps.metrics?.incCounter("task.run.complete", { exit: exitCode === 0 ? "ok" : "error" });
    const releasedServerAccess = releaseServerAccess(db as any, {
      nowMs: nowMs(),
      taskId,
      reason: exitCode === 0 ? "task_completed" : "task_failed",
    });
    if (releasedServerAccess.released_allocations > 0) {
      appendTaskLog(
        taskId,
        "system",
        `Server access released: allocations=${releasedServerAccess.released_allocations}, servers=${releasedServerAccess.touched_server_ids.join(", ") || "none"}`,
      );
      broadcast("server_update", { action: "allocation_released", task_id: taskId, release: releasedServerAccess });
    }

    // Get latest task snapshot early for stop/delete race handling.
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as
      | {
          assigned_agent_id: string | null;
          department_id: string | null;
          title: string;
          description: string | null;
          status: string;
          task_type: string | null;
          workflow_pack_key: string | null;
          workflow_meta_json: string | null;
          project_id: string | null;
          project_path: string | null;
          source_task_id: string | null;
        }
      | undefined;
    const stopRequested = stopRequestedTasks.has(taskId);
    const stopMode = stopRequestModeByTask.get(taskId);
    stopRequestedTasks.delete(taskId);
    stopRequestModeByTask.delete(taskId);

    // If task was stopped/deleted or no longer in-progress, ignore late close events.
    if (!task || stopRequested || task.status !== "in_progress") {
      if (task) {
        appendTaskLog(
          taskId,
          "system",
          `RUN completion ignored (status=${task.status}, exit=${exitCode}, stop_requested=${stopRequested ? "yes" : "no"}, stop_mode=${stopMode ?? "none"})`,
        );
      }
      const keepWorkflowForResume = stopRequested && stopMode === "pause";
      if (!keepWorkflowForResume) {
        clearTaskWorkflowState(taskId);
        // Clean up graph-runner trace state to prevent memory leak
        if (deps.graphRunner) {
          deps.graphRunner.cleanupTask(taskId);
        }
      }
      return;
    }

    // Clean up Codex thread→subtask mappings for this task's subtasks
    for (const [tid, itemId] of codexThreadToSubtask) {
      const row = db.prepare("SELECT id FROM subtasks WHERE cli_tool_use_id = ? AND task_id = ?").get(itemId, taskId);
      if (row) codexThreadToSubtask.delete(tid);
    }

    const logPath = path.join(logsDir, `${taskId}.log`);
    const finalExitCode = exitCode;
    let result: string | null = null;
    try {
      if (fs.existsSync(logPath)) {
        const raw = fs.readFileSync(logPath, "utf8");
        result = raw.slice(-2000);
      }
    } catch (err) {
      log.debug(
        { err, taskId, operation: "read_task_log_file" },
        "cannot read task log file — skipping exit code extraction",
      );
    }
    const logKind = finalExitCode === 0 ? "completed" : "failed";
    appendTaskLog(taskId, "system", `RUN ${logKind} (exit code: ${finalExitCode})`);

    if (result) {
      db.prepare("UPDATE tasks SET result = ? WHERE id = ?").run(result, taskId);
    }

    if (finalExitCode === 0 && task) {
      const docsSync = syncTaskDocsBackToVault({
        db: db as any,
        task: {
          id: taskId,
          project_id: task.project_id,
          project_path: task.project_path,
        },
        taskWorktrees: taskWorktrees as any,
        appendTaskLog,
      });
      if (docsSync.syncedProviders > 0) {
        appendTaskLog(
          taskId,
          "system",
          `Docs sync complete: providers=${docsSync.syncedProviders}, copied_files=${docsSync.copiedFiles}`,
        );
      }
    }

    // Auto-complete own-department subtasks on CLI success; foreign ones get delegated
    // Pipeline subtasks ([pipeline:...]) are excluded — they are managed by phase advancement logic.
    if (finalExitCode === 0) {
      const pendingSubtasks = db
        .prepare(
          "SELECT id, title, target_department_id FROM subtasks WHERE task_id = ? AND status NOT IN ('done', 'cancelled')",
        )
        .all(taskId) as Array<{ id: string; title: string | null; target_department_id: string | null }>;
      if (pendingSubtasks.length > 0) {
        const now = nowMs();
        for (const sub of pendingSubtasks) {
          // Skip pipeline subtasks — they advance via phase logic below
          const title = typeof sub.title === "string" ? sub.title : "";
          const isPipelineSubtask = title.startsWith("[pipeline:");
          // Only auto-complete subtasks without a foreign department target
          if (!sub.target_department_id && !isPipelineSubtask) {
            db.prepare("UPDATE subtasks SET status = 'done', completed_at = ? WHERE id = ?").run(now, sub.id);
            const updated = db.prepare("SELECT * FROM subtasks WHERE id = ?").get(sub.id);
            broadcast("subtask_update", updated);
          }
        }
      }
      // Trigger delegation for foreign-department subtasks
      processSubtaskDelegations(taskId);

      // ── Graph-runner phase advancement path (new) ──
      // If the pack key is registered in the pack registry, delegate phase advancement to graph runner.
      // Falls through to legacy handlers if pack is not in registry.
      const packRegistryInst: PackRegistry | undefined = deps.packRegistry;
      const graphRunnerInst: GraphRunner | undefined = deps.graphRunner;
      if (task.workflow_pack_key && packRegistryInst && graphRunnerInst) {
        let registryPackForComplete: import("../../../packs/pack-loader.ts").LoadedPack | null = null;
        try {
          registryPackForComplete = packRegistryInst.get(task.workflow_pack_key);
        } catch (err) {
          log.debug(
            { err, taskId, operation: "get_pack_from_registry", packKey: task.workflow_pack_key },
            "pack not in registry — using legacy handlers",
          );
        }
        if (registryPackForComplete) {
          // Find the completed pipeline subtask title — the agent was working on an in_progress subtask
          const completedSubtask = (db as any)
            .prepare(
              "SELECT title FROM subtasks WHERE task_id = ? AND title LIKE '[pipeline:%' AND status = 'in_progress' ORDER BY created_at DESC LIMIT 1",
            )
            .get(taskId) as { title?: string } | undefined;

          const phaseMatch = completedSubtask?.title?.match(/^\[pipeline:([^\]]+)\]/);
          // Strip fan-out index from phase ID (e.g. "image_generation:0" → "image_generation")
          const rawPhaseId = phaseMatch ? phaseMatch[1] : null;
          const completedPhaseId = rawPhaseId?.includes(":") ? rawPhaseId.split(":")[0] : rawPhaseId;

          if (completedPhaseId) {
            // Mark the completed phase subtask as done
            (db as any)
              .prepare("UPDATE subtasks SET status = 'done', completed_at = ? WHERE task_id = ? AND title = ?")
              .run(nowMs(), taskId, completedSubtask?.title);

            // Use task's project_path; log a warning if falling back to cwd (should not happen)
            const rootDir = task.project_path || process.cwd();
            if (!task.project_path) {
              appendTaskLog(
                taskId,
                "warn",
                "Task has no project_path — falling back to process.cwd(); artifacts may leak between tasks",
              );
            }
            const result = await graphRunnerInst.onPhaseComplete(
              wrapDatabaseSync(db),
              taskId,
              completedPhaseId,
              registryPackForComplete,
              rootDir,
            );

            // Helper: release agent back to idle (shared across all graph-runner outcomes)
            const releaseAgent = () => {
              if (task?.assigned_agent_id) {
                db.prepare("UPDATE agents SET status = 'idle', current_task_id = NULL WHERE id = ?").run(
                  task.assigned_agent_id,
                );
                const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(task.assigned_agent_id) as
                  | Record<string, unknown>
                  | undefined;
                broadcast("agent_status", agent);
              }
            };

            if (result.taskDone) {
              // All terminal phases complete — finalize the task
              appendTaskLog(taskId, "system", `Graph-runner: all terminal phases complete — task done`);
              releaseAgent();
              // Delegate to handleSuccessPath for proper finalization (review flow, status update, etc.)
              handleSuccessPath(deps, task, taskId, finalExitCode, logPath, {});
              return;
            } else if (result.nextPhases.length > 0) {
              // More phases to run — release agent, set task to planned, trigger re-run
              appendTaskLog(
                taskId,
                "system",
                `Graph-runner: phase '${completedPhaseId}' complete, next phases: ${result.nextPhases.join(", ")}`,
              );
              releaseAgent();

              // Department routing: reassign agent if routing mode is "department"
              const routingMode = resolveAgentRouting(
                {
                  agent_routing: (task as any).agent_routing ?? null,
                  workflow_pack_key: (task as any).workflow_pack_key ?? null,
                },
                packRegistryInst ?? null,
              );
              if (routingMode === "department" && registryPackForComplete) {
                const nextPhaseId = result.nextPhases[0];
                // Strip fan-out index (e.g. "crawl:0" → "crawl")
                const baseNextPhaseId = nextPhaseId.includes(":") ? nextPhaseId.split(":")[0] : nextPhaseId;
                const nextPhase = registryPackForComplete.graph.phases.find((p: any) => p.id === baseNextPhaseId);
                const targetDept = nextPhase?.department;
                if (targetDept) {
                  const currentAgent = db
                    .prepare("SELECT department_id FROM agents WHERE id = ?")
                    .get((task as any).assigned_agent_id) as { department_id: string | null } | undefined;
                  if (currentAgent && currentAgent.department_id !== targetDept) {
                    const nextAgentResult = selectAgentForDepartment(
                      db as any,
                      {
                        workflow_pack_key: (task as any).workflow_pack_key,
                        department_id: targetDept,
                        project_id: (task as any).project_id,
                      },
                      targetDept,
                    );
                    if (nextAgentResult) {
                      db.prepare(
                        "UPDATE tasks SET assigned_agent_id = ?, department_id = ?, updated_at = ? WHERE id = ?",
                      ).run(nextAgentResult.agent.id, targetDept, nowMs(), taskId);
                      appendTaskLog(
                        taskId,
                        "system",
                        `Phase routing: ${completedPhaseId} → ${nextPhaseId}, agent → ${nextAgentResult.agent.name} (${targetDept})`,
                      );
                    }
                  }
                }
              }

              db.prepare("UPDATE tasks SET status = 'planned', updated_at = ? WHERE id = ?").run(nowMs(), taskId);
              const updatedTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
              broadcast("task_update", updatedTask);
              triggerTaskReRun(taskId, `graph_phase_${result.nextPhases[0]}`);
              return;
            } else {
              // Gate or review-fail scenario — release agent, keep task in planned state
              appendTaskLog(
                taskId,
                "system",
                `Graph-runner: phase '${completedPhaseId}' advanced, awaiting gate or review`,
              );
              releaseAgent();
              db.prepare("UPDATE tasks SET status = 'planned', updated_at = ? WHERE id = ?").run(nowMs(), taskId);
              const updatedTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
              broadcast("task_update", updatedTask);
              return;
            }
          }
        }
      }
    }

    // Update agent status back to idle
    if (task?.assigned_agent_id) {
      db.prepare("UPDATE agents SET status = 'idle', current_task_id = NULL WHERE id = ?").run(task.assigned_agent_id);

      const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(task.assigned_agent_id) as
        | Record<string, unknown>
        | undefined;
      broadcast("agent_status", agent);
    }

    // Autonomous task chaining: trigger scheduler tick to immediately assign next task
    if (finalExitCode === 0 && typeof deps.autonomousSchedulerTick === "function") {
      setTimeout(() => {
        try {
          deps.autonomousSchedulerTick!();
        } catch (err) {
          log.warn({ err, taskId, operation: "autonomous_scheduler_tick" }, "scheduler tick failed");
        }
      }, 3_000);
    }

    if (finalExitCode === 0 && task) {
      // Department pipeline advancement
      const deptResult = handleDeptPipelineAdvancement(
        deps,
        task,
        taskId,
        finalExitCode,
        logPath,
        {},
        result,
        triggerTaskReRun,
      );
      if (deptResult.handled) return;

      // Success-path report/design/checkpoint handlers and review flow
      handleSuccessPath(deps, task, taskId, finalExitCode, logPath, {});
    } else {
      // ── Auto-Retry / QA Bounce-back ──
      if (task) {
        // QA bounce-back
        const bounceResult = handleQaBounceBack(
          deps,
          task,
          taskId,
          finalExitCode,
          logPath,
          {},
          result,
          triggerTaskReRun,
        );
        if (bounceResult.handled) return;

        // Auto-retry
        const retryResult = handleAutoRetry(deps, task, taskId, finalExitCode, logPath, {}, triggerTaskReRun);
        if (retryResult.handled) return;
      }

      // Hard failure
      if (task) {
        handleHardFailure(deps, task, taskId, finalExitCode, logPath, {});
      } else {
        appendTaskLog(taskId, "error", `Task ${taskId} not found during hard failure handling`);
      }
      // Clean up graph-runner trace state on failure to prevent memory leak
      if (deps.graphRunner) {
        deps.graphRunner.cleanupTask(taskId);
      }
    }
  }

  return {
    handleTaskRunComplete,
    cancelPendingReRuns,
  };
}
