import type { Express } from "express";
import type { DatabaseSync } from "node:sqlite";
import type { ChildProcess } from "node:child_process";
import type { PackRegistry } from "../../../../packs/pack-registry.ts";
import type { GraphRunner } from "../../../workflow/orchestration/graph-runner.ts";
import { requireAuth } from "../../../../security/auth.ts";
import { wrapDatabaseSync } from "../../../workflow/orchestration/graph-runner.ts";

interface SubtaskRow {
  id: string;
  task_id: string;
  title: string;
  description: string;
  status: string;
}

interface TaskRow {
  id: string;
  title: string;
  status: string;
  workflow_pack_key: string | null;
  project_path: string | null;
  assigned_agent_id: string | null;
}

export interface PhaseApprovalRouteDeps {
  app: Express;
  db: DatabaseSync;
  nowMs(): number;
  broadcast(type: string, payload: unknown): void;
  appendTaskLog(taskId: string, kind: string, message: string): void;
  packRegistry?: PackRegistry;
  graphRunner?: GraphRunner;
  activeProcesses: Map<string, ChildProcess>;
  stopRequestedTasks: Set<string>;
  killPidTree(pid: number): void;
  endTaskExecutionSession(taskId: string, reason?: string): void;
  /**
   * Programmatic task re-run (replaces the legacy HTTP self-fetch loop).
   * Wired from the lifecycle composition; mirrors `RunCompleteDeps.runTask`.
   */
  runTask(taskId: string): Promise<void>;
}

export function registerPhaseApprovalRoutes(deps: PhaseApprovalRouteDeps): void {
  const {
    app,
    db,
    nowMs,
    broadcast,
    appendTaskLog,
    activeProcesses,
    stopRequestedTasks,
    killPidTree,
    endTaskExecutionSession,
  } = deps;

  /** Stop any active agent process for the given task before resetting phases. */
  function stopActiveRun(taskId: string): void {
    const child = activeProcesses.get(taskId);
    if (child) {
      const pid = typeof child.pid === "number" ? child.pid : null;
      stopRequestedTasks.add(taskId);
      if (pid && pid > 0) {
        try {
          killPidTree(pid);
        } catch {
          // best-effort
        }
      }
      activeProcesses.delete(taskId);
      appendTaskLog(taskId, "system", `Stopped active run (pid=${pid}) before phase reset`);
    }
    endTaskExecutionSession(taskId);
  }

  /**
   * POST /api/core/tasks/:taskId/phases/:phaseId/approve
   *
   * Approves a gated pipeline phase that is awaiting user approval.
   * Sets the subtask status to 'done' and triggers downstream phase unblocking.
   */
  app.post("/api/core/tasks/:taskId/phases/:phaseId/approve", requireAuth, async (req, res) => {
    const taskId = String(req.params.taskId);
    const phaseId = String(req.params.phaseId);

    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as TaskRow | undefined;
    if (!task) {
      return res.status(404).json({ error: "task_not_found" });
    }

    // Find the subtask matching [pipeline:{phaseId}] with status 'awaiting_approval'
    // Use exact match to prevent LIKE wildcard injection from user-supplied phaseId
    const subtask = db
      .prepare("SELECT * FROM subtasks WHERE task_id = ? AND title = ? AND status = 'awaiting_approval' LIMIT 1")
      .get(taskId, `[pipeline:${phaseId}]`) as SubtaskRow | undefined;

    if (!subtask) {
      return res.status(404).json({ error: "phase_not_awaiting_approval", phaseId });
    }

    // Stop any active agent run before mutating phase state. Without this, the
    // previous agent process can race with the re-trigger fired below for the
    // next phase (double-execution, conflicting cleanupTask, stale agent_status
    // broadcasts). Mirrors the /reset and /reset-from endpoints. (C-003, #57)
    stopActiveRun(taskId);

    // Mark the subtask as 'done'
    db.prepare("UPDATE subtasks SET status = 'done', completed_at = ? WHERE id = ?").run(nowMs(), subtask.id);

    const updatedSubtask = db.prepare("SELECT * FROM subtasks WHERE id = ?").get(subtask.id);
    broadcast("subtask_update", updatedSubtask);
    appendTaskLog(taskId, "system", `Phase '${phaseId}' approved by user`);

    // Attempt graph-runner phase advancement
    const nextPhases: string[] = [];
    let taskDone = false;

    const packRegistryInst = deps.packRegistry;
    const graphRunnerInst = deps.graphRunner;

    if (task.workflow_pack_key && packRegistryInst && graphRunnerInst) {
      let registryPack = null;
      try {
        registryPack = packRegistryInst.get(task.workflow_pack_key);
      } catch {
        // pack not in registry — no graph advancement
      }

      if (registryPack) {
        const rootDir = task.project_path ?? process.cwd();
        const result = await graphRunnerInst.onPhaseComplete(
          wrapDatabaseSync(db),
          taskId,
          phaseId,
          registryPack,
          rootDir,
          {
            approved: true,
          },
        );

        nextPhases.push(...result.nextPhases);
        taskDone = result.taskDone;

        if (taskDone) {
          appendTaskLog(taskId, "system", `Graph-runner: all terminal phases complete after approval — task done`);

          // Finalize the task: mark as done, release agent, broadcast updates
          const now = nowMs();
          db.prepare("UPDATE tasks SET status = 'done', completed_at = ?, updated_at = ? WHERE id = ?").run(
            now,
            now,
            taskId,
          );
          const finalTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
          broadcast("task_update", finalTask);

          if (task.assigned_agent_id) {
            db.prepare("UPDATE agents SET status = 'idle', current_task_id = NULL WHERE id = ?").run(
              task.assigned_agent_id,
            );
            const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(task.assigned_agent_id);
            broadcast("agent_status", agent);
          }
        } else if (result.nextPhases.length > 0) {
          appendTaskLog(
            taskId,
            "system",
            `Graph-runner: phase '${phaseId}' approved, next phases: ${result.nextPhases.join(", ")}`,
          );

          // Release assigned agent and trigger re-run
          if (task.assigned_agent_id) {
            db.prepare("UPDATE agents SET status = 'idle', current_task_id = NULL WHERE id = ?").run(
              task.assigned_agent_id,
            );
            const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(task.assigned_agent_id);
            broadcast("agent_status", agent);
          }

          db.prepare("UPDATE tasks SET status = 'planned', updated_at = ? WHERE id = ?").run(nowMs(), taskId);
          const updatedTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
          broadcast("task_update", updatedTask);

          // Trigger re-run via direct deps.runTask call (mirrors run-complete-handler).
          // The 2.5s delay matches run-complete-handler's pendingReRun timing so
          // pre-existing settle/cleanup behavior is preserved.
          setTimeout(() => {
            deps.runTask(taskId).catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              appendTaskLog(taskId, "error", `Phase approval re-run trigger failed: ${msg}`);
            });
          }, 2500);
        }
      }
    }

    return res.json({ approved: true, phaseId, nextPhases, taskDone });
  });

  /**
   * POST /api/core/tasks/:taskId/phases/:phaseId/reset
   *
   * Resets a single pipeline phase back to 'pending' so it can be re-executed.
   */
  app.post("/api/core/tasks/:taskId/phases/:phaseId/reset", requireAuth, (_req, res) => {
    const taskId = String(_req.params.taskId);
    const phaseId = String(_req.params.phaseId);

    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as TaskRow | undefined;
    if (!task) return res.status(404).json({ error: "task_not_found" });

    // Use exact match to prevent LIKE wildcard injection from user-supplied phaseId
    const subtask = db
      .prepare("SELECT * FROM subtasks WHERE task_id = ? AND title = ? LIMIT 1")
      .get(taskId, `[pipeline:${phaseId}]`) as SubtaskRow | undefined;
    if (!subtask) return res.status(404).json({ error: "phase_not_found", phaseId });

    // Stop any active run before mutating state
    stopActiveRun(taskId);

    db.prepare("UPDATE subtasks SET status = 'pending', completed_at = NULL WHERE id = ?").run(subtask.id);

    const updated = db.prepare("SELECT * FROM subtasks WHERE id = ?").get(subtask.id);
    broadcast("subtask_update", updated);
    appendTaskLog(taskId, "system", `Phase '${phaseId}' reset to pending by user`);

    // Release assigned agent
    if (task.assigned_agent_id) {
      db.prepare("UPDATE agents SET status = 'idle', current_task_id = NULL WHERE id = ?").run(task.assigned_agent_id);
      const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(task.assigned_agent_id);
      broadcast("agent_status", agent);
    }

    // If task is in review/done, move it back to planned so it can be re-run
    if (task.status === "review" || task.status === "done") {
      db.prepare("UPDATE tasks SET status = 'planned', updated_at = ? WHERE id = ?").run(nowMs(), taskId);
      const updatedTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
      broadcast("task_update", updatedTask);
    }

    return res.json({ reset: true, phaseId });
  });

  /**
   * POST /api/core/tasks/:taskId/phases/reset-from/:phaseId
   *
   * Resets the given phase and all downstream phases back to 'pending'/'blocked'.
   * The target phase is set to 'pending', all phases after it to 'blocked'.
   */
  app.post("/api/core/tasks/:taskId/phases/reset-from/:phaseId", requireAuth, (_req, res) => {
    const taskId = String(_req.params.taskId);
    const phaseId = String(_req.params.phaseId);

    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as TaskRow | undefined;
    if (!task) return res.status(404).json({ error: "task_not_found" });

    // Stop any active run before mutating state
    stopActiveRun(taskId);

    // Walk the graph topology to find all downstream phases
    const packRegistryInst = deps.packRegistry;
    const downstreamPhaseIds = new Set<string>();

    // Strip fan-out index for graph lookup (e.g. "image_generation:0" → "image_generation")
    const basePhaseId = phaseId.includes(":") ? phaseId.split(":")[0] : phaseId;

    if (task.workflow_pack_key && packRegistryInst) {
      try {
        const registryPack = packRegistryInst.get(task.workflow_pack_key);
        if (registryPack) {
          // BFS from phaseId through adjacency map to collect all downstream phases.
          // Only use graph-based reset when the phase actually exists in the DAG —
          // ad-hoc subtask phases not declared in the pack would otherwise prevent
          // the fallback creation-order reset from running.
          const adjacency = registryPack.graph.adjacency;
          if (adjacency.has(basePhaseId)) {
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
          }
        }
      } catch {
        // pack not found — fall through to subtask-based reset
      }
    }

    // Get all pipeline subtasks for this task
    const allPipelineSubtasks = db
      .prepare(
        "SELECT id, title, status FROM subtasks WHERE task_id = ? AND title LIKE '[pipeline:%' AND title != '[pipeline:__input__]'",
      )
      .all(taskId) as unknown as SubtaskRow[];

    const resetPhases: string[] = [];

    if (downstreamPhaseIds.size > 0) {
      // Graph-topology-based reset
      for (const sub of allPipelineSubtasks) {
        const match = sub.title.match(/\[pipeline:([^\]]+)\]/);
        if (!match) continue;
        const subPhaseId = match[1];
        // Strip fan-out index for comparison
        const subBaseId = subPhaseId.includes(":") ? subPhaseId.split(":")[0] : subPhaseId;
        if (!downstreamPhaseIds.has(subBaseId)) continue;

        const newStatus = subBaseId === basePhaseId ? "pending" : "blocked";
        db.prepare("UPDATE subtasks SET status = ?, completed_at = NULL WHERE id = ?").run(newStatus, sub.id);
        const updated = db.prepare("SELECT * FROM subtasks WHERE id = ?").get(sub.id);
        broadcast("subtask_update", updated);
        resetPhases.push(subPhaseId);
      }
    } else {
      // Fallback: no graph available — reset target + all subtasks created after it
      const sorted = [...allPipelineSubtasks];
      const targetIdx = sorted.findIndex((s) => s.title.includes(`[pipeline:${phaseId}]`));
      if (targetIdx === -1) return res.status(404).json({ error: "phase_not_found", phaseId });

      for (let i = targetIdx; i < sorted.length; i++) {
        const sub = sorted[i];
        const newStatus = i === targetIdx ? "pending" : "blocked";
        db.prepare("UPDATE subtasks SET status = ?, completed_at = NULL WHERE id = ?").run(newStatus, sub.id);
        const updated = db.prepare("SELECT * FROM subtasks WHERE id = ?").get(sub.id);
        broadcast("subtask_update", updated);
        const match = sub.title.match(/\[pipeline:([^\]]+)\]/);
        if (match) resetPhases.push(match[1]);
      }
    }

    if (resetPhases.length === 0) {
      return res.status(404).json({ error: "phase_not_found", phaseId });
    }

    appendTaskLog(taskId, "system", `Pipeline reset from '${phaseId}': ${resetPhases.length} phases reset`);

    // Move task back to planned
    if (task.status !== "planned" && task.status !== "pending" && task.status !== "inbox") {
      db.prepare("UPDATE tasks SET status = 'planned', updated_at = ? WHERE id = ?").run(nowMs(), taskId);
      const updatedTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
      broadcast("task_update", updatedTask);
    }

    // Release assigned agent
    if (task.assigned_agent_id) {
      db.prepare("UPDATE agents SET status = 'idle', current_task_id = NULL WHERE id = ?").run(task.assigned_agent_id);
      const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(task.assigned_agent_id);
      broadcast("agent_status", agent);
    }

    return res.json({ reset: true, phaseId, resetPhases });
  });
}
