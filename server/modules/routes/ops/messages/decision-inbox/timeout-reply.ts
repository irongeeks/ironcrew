import type { AgentRow } from "../../../shared/types.ts";
import type { TimeoutReplyInput } from "./types.ts";

export function handleTimeoutResumeDecisionReply(input: TimeoutReplyInput): boolean {
  const { res, currentItem, selectedOption, deps } = input;
  if (currentItem.kind !== "task_timeout_resume") return false;

  const { db, activeProcesses, getDeptName, appendTaskLog, startTaskExecutionForAgent } = deps;

  const taskId = currentItem.task_id;
  if (!taskId) {
    res.status(400).json({ error: "task_id_required" });
    return true;
  }
  const selectedAction = selectedOption.action;

  if (selectedAction === "keep_inbox") {
    res.json({
      ok: true,
      resolved: false,
      kind: "task_timeout_resume",
      action: "keep_inbox",
    });
    return true;
  }
  if (selectedAction !== "resume_timeout_task") {
    res.status(400).json({ error: "unsupported_timeout_action", action: selectedAction });
    return true;
  }

  const task = db
    .prepare(
      `
      SELECT id, title, description, status, assigned_agent_id, department_id
      FROM tasks
      WHERE id = ?
    `,
    )
    .get(taskId) as
    | {
        id: string;
        title: string;
        description: string | null;
        status: string;
        assigned_agent_id: string | null;
        department_id: string | null;
      }
    | undefined;
  if (!task) {
    res.status(404).json({ error: "task_not_found" });
    return true;
  }
  if (task.status !== "inbox") {
    res.status(409).json({ error: "task_not_in_inbox", status: task.status });
    return true;
  }
  if (!task.assigned_agent_id) {
    res.status(409).json({ error: "task_has_no_assigned_agent" });
    return true;
  }

  const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(task.assigned_agent_id) as AgentRow | undefined;
  if (!agent) {
    res.status(404).json({ error: "agent_not_found" });
    return true;
  }

  if (activeProcesses.has(taskId)) {
    res.status(409).json({ error: "already_running" });
    return true;
  }
  if (
    agent.status === "working" &&
    agent.current_task_id &&
    agent.current_task_id !== taskId &&
    activeProcesses.has(agent.current_task_id)
  ) {
    res.status(409).json({
      error: "agent_busy",
      current_task_id: agent.current_task_id,
    });
    return true;
  }

  const deptId = agent.department_id ?? task.department_id ?? null;
  const deptName = deptId ? getDeptName(deptId) : "Unassigned";
  appendTaskLog(taskId, "system", "Decision inbox: timeout resume approved by CEO");
  startTaskExecutionForAgent(taskId, agent, deptId, deptName);

  res.json({
    ok: true,
    resolved: true,
    kind: "task_timeout_resume",
    action: "resume_timeout_task",
    task_id: taskId,
  });
  return true;
}
