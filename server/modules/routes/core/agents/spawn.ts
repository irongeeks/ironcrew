import fs from "node:fs";
import path from "node:path";
import type { Express } from "express";
import type { DatabaseSync } from "node:sqlite";
import { notifyTaskStatus } from "../../../../gateway/client.ts";
import type { TaskExecutionContext } from "../../../../types/runtime-context-domains.ts";
import type { Lang, TaskExecutionSessionState } from "../../../../types/workflow-types.ts";
import type { L10n } from "../../collab/language-policy.ts";
import { ensureVideoPreprodRemotionBestPracticesSkill } from "../../../workflow/core/video-skill-bootstrap.ts";

interface AgentSpawnRouteBaseDeps {
  app: Express;
  db: DatabaseSync;
  logsDir: string;
  nowMs(): number;
  broadcast(type: string, payload: unknown): void;
}

interface AgentSpawnRouteUtilDeps {
  createWorktree(projectPath: string, taskId: string, agentName: string, baseBranch?: string): string | null;
  ensureTaskExecutionSession(taskId: string, agentId: string, provider: string): TaskExecutionSessionState;
  getDeptRoleConstraint(deptId: string, deptName: string): string;
  normalizeTextField(value: unknown): string | null;
  appendTaskLog(taskId: string, kind: string, message: string): void;
  getProviderModelConfig(): Record<
    string,
    { model: string; subModel?: string; reasoningLevel?: string; subModelReasoningLevel?: string }
  >;
  getNextHttpAgentPid(): number;
  handleTaskRunComplete(taskId: string, exitCode: number): void;
}

interface AgentSpawnRouteMessagingDeps {
  resolveLang(text?: string, fallback?: Lang): Lang;
  pickL(pool: L10n, lang: Lang): string;
  l(ko: string[], en: string[], ja?: string[], zh?: string[], de?: string[]): L10n;
}

export function registerAgentSpawnRoute(
  base: AgentSpawnRouteBaseDeps,
  taskExec: Pick<
    TaskExecutionContext,
    | "buildTaskExecutionPrompt"
    | "hasExplicitWarningFixRequest"
    | "ensureClaudeMd"
    | "launchApiProviderAgent"
    | "launchHttpAgent"
    | "spawnCliAgent"
    | "buildAvailableSkillsPromptBlock"
  >,
  utilDeps: AgentSpawnRouteUtilDeps,
  messagingDeps: AgentSpawnRouteMessagingDeps,
): void {
  const { app, db, logsDir, nowMs, broadcast } = base;
  const {
    createWorktree,
    ensureTaskExecutionSession,
    getDeptRoleConstraint,
    normalizeTextField,
    appendTaskLog,
    getProviderModelConfig,
    getNextHttpAgentPid,
    handleTaskRunComplete,
  } = utilDeps;
  const { resolveLang, pickL, l } = messagingDeps;
  const {
    ensureClaudeMd,
    buildTaskExecutionPrompt,
    hasExplicitWarningFixRequest,
    launchApiProviderAgent,
    launchHttpAgent,
    spawnCliAgent,
  } = taskExec;
  const buildAvailableSkillsPromptBlock =
    taskExec.buildAvailableSkillsPromptBlock ||
    ((provider: string) => `[Available Skills][provider=${provider || "unknown"}][unavailable]`);

  app.post("/api/agents/:id/spawn", (req, res) => {
    const id = String(req.params.id);
    let agent:
      | {
          id: string;
          name: string;
          role: string;
          cli_provider: string | null;
          oauth_account_id: string | null;
          api_provider_id: string | null;
          api_model: string | null;
          cli_model: string | null;
          cli_reasoning_level: string | null;
          cli_profile: string | null;
          personality: string | null;
          department_id: string | null;
          department_name: string | null;
          department_prompt: string | null;
          current_task_id: string | null;
          status: string;
        }
      | undefined;
    try {
      agent = db
        .prepare(
          `
      SELECT
        a.*,
        COALESCE(opd.name, d.name) AS department_name,
        COALESCE(opd.prompt, d.prompt) AS department_prompt
      FROM agents a
      LEFT JOIN tasks t ON t.id = a.current_task_id
      LEFT JOIN office_pack_departments opd
        ON opd.workflow_pack_key = COALESCE(t.workflow_pack_key, 'development')
       AND opd.department_id = a.department_id
      LEFT JOIN departments d ON d.id = a.department_id
      WHERE a.id = ?
    `,
        )
        .get(id) as
        | {
            id: string;
            name: string;
            role: string;
            cli_provider: string | null;
            oauth_account_id: string | null;
            api_provider_id: string | null;
            api_model: string | null;
            cli_model: string | null;
            cli_reasoning_level: string | null;
            cli_profile: string | null;
            personality: string | null;
            department_id: string | null;
            department_name: string | null;
            department_prompt: string | null;
            current_task_id: string | null;
            status: string;
          }
        | undefined;
    } catch {
      agent = db
        .prepare(
          `
      SELECT a.*, d.name AS department_name, d.prompt AS department_prompt
      FROM agents a
      LEFT JOIN departments d ON d.id = a.department_id
      WHERE a.id = ?
    `,
        )
        .get(id) as
        | {
            id: string;
            name: string;
            role: string;
            cli_provider: string | null;
            oauth_account_id: string | null;
            api_provider_id: string | null;
            api_model: string | null;
            cli_model: string | null;
            cli_reasoning_level: string | null;
            cli_profile: string | null;
            personality: string | null;
            department_id: string | null;
            department_name: string | null;
            department_prompt: string | null;
            current_task_id: string | null;
            status: string;
          }
        | undefined;
    }
    if (!agent) return res.status(404).json({ ok: false, error: "not_found" });

    const provider = agent.cli_provider || "claude";
    if (!["claude", "codex", "gemini", "opencode", "copilot", "antigravity", "api", "openclaw"].includes(provider)) {
      return res.status(400).json({ ok: false, error: "unsupported_provider", provider });
    }

    const taskId = agent.current_task_id;
    if (!taskId) {
      return res
        .status(400)
        .json({ ok: false, error: "no_task_assigned", message: "Assign a task to this agent first." });
    }

    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as
      | {
          id: string;
          title: string;
          description: string | null;
          workflow_pack_key: string | null;
          project_id: string | null;
          department_id: string | null;
          project_path: string | null;
          task_type: string | null;
          workflow_meta_json: string | null;
        }
      | undefined;
    if (!task) {
      return res.status(400).json({ ok: false, error: "task_not_found" });
    }
    ensureVideoPreprodRemotionBestPracticesSkill({
      db: db as any,
      nowMs,
      workflowPackKey: task.workflow_pack_key,
      provider,
      taskId,
      appendTaskLog,
    });
    const taskLang = resolveLang(task.description ?? task.title);

    const projectPath = task.project_path || null;
    if (!projectPath) {
      appendTaskLog(
        taskId,
        "error",
        "Execution blocked: no project path is set. Please assign a project path before spawning.",
      );
      return res.status(400).json({
        ok: false,
        error: "project_path_required",
        message: "No project path is configured for this task. Set a project path before spawning an agent.",
      });
    }

    let agentCwd: string;
    const isGitRepo = fs.existsSync(path.join(projectPath, ".git"));
    if (!isGitRepo) {
      agentCwd = projectPath;
      appendTaskLog(taskId, "system", `Using project path directly (not a git repo): ${projectPath}`);
    } else {
      const worktreePath = createWorktree(projectPath, taskId, agent.name);
      if (!worktreePath) {
        appendTaskLog(
          taskId,
          "error",
          `Execution blocked: isolated worktree creation failed for project path '${projectPath}'`,
        );
        return res.status(409).json({
          ok: false,
          error: "worktree_required",
          message: "Isolated worktree creation failed. Task execution was blocked to protect the project root.",
        });
      }
      agentCwd = worktreePath;
      appendTaskLog(taskId, "system", `Git worktree created: ${worktreePath} (branch: ironcrew/${taskId.slice(0, 8)})`);
      if (provider === "claude") {
        ensureClaudeMd(projectPath, worktreePath);
      }
    }
    const logPath = path.join(logsDir, `${taskId}.log`);
    const executionSession = ensureTaskExecutionSession(taskId, agent.id, provider);
    const availableSkillsPromptBlock = buildAvailableSkillsPromptBlock(provider);
    const roleLabel =
      { team_leader: "Team Leader", senior: "Senior", junior: "Junior", intern: "Intern" }[agent.role] || agent.role;
    const deptConstraint = agent.department_id
      ? getDeptRoleConstraint(agent.department_id, agent.department_name || agent.department_id)
      : "";
    const departmentPrompt = normalizeTextField(agent.department_prompt);
    const departmentPromptBlock = departmentPrompt ? `[Department Shared Prompt]\n${departmentPrompt}` : "";
    let sshGuidance = "";
    try {
      const alloc = (db as any)
        .prepare(
          "SELECT sa.server_id, s.id, s.name, s.ssh_config_json FROM server_allocations sa JOIN servers s ON s.id = sa.server_id WHERE sa.task_id = ? AND sa.status = 'active' AND s.ssh_config_json IS NOT NULL LIMIT 1",
        )
        .get(task.id) as { id: string; name: string; ssh_config_json: string } | undefined;
      if (alloc) {
        try {
          const sshCfg = JSON.parse(alloc.ssh_config_json) as { host?: string; port?: number; user?: string };
          sshGuidance = `\n[SSH Server] ${alloc.name}: ssh ${sshCfg.user ?? "user"}@${sshCfg.host ?? ""}${sshCfg.port && sshCfg.port !== 22 ? `:${sshCfg.port}` : ""}`;
        } catch {
          // best-effort
        }
      }
    } catch {
      // best-effort: table may not exist in older DBs
    }

    const prompt = buildTaskExecutionPrompt(
      [
        availableSkillsPromptBlock,
        `[Task Session] id=${executionSession.sessionId} owner=${executionSession.agentId} provider=${executionSession.provider}`,
        "This session is scoped to this task only.",
        `[Task] ${task.title}`,
        task.description ? `\n${task.description}` : "",
        sshGuidance,
        `NOTE: You are working in an isolated Git worktree branch (ironcrew/${taskId.slice(0, 8)}). Commit your changes normally.`,
        `Agent: ${agent.name} (${roleLabel}, ${agent.department_name || "Unassigned"})`,
        agent.personality ? `Personality: ${agent.personality}` : "",
        deptConstraint,
        departmentPromptBlock,
        pickL(
          l(
            ["위 작업을 충분히 완수하세요."],
            ["Please complete the task above thoroughly."],
            ["上記タスクを丁寧に完了してください。"],
            ["请完整地完成上述任务。"],
          ),
          taskLang,
        ),
      ],
      {
        allowWarningFix: hasExplicitWarningFixRequest(task.title, task.description),
      },
    );

    appendTaskLog(taskId, "system", `RUN start (agent=${agent.name}, provider=${provider})`);

    const spawnModelConfig = getProviderModelConfig();
    const spawnModel = agent.cli_model || spawnModelConfig[provider]?.model || undefined;
    const spawnReasoningLevel =
      provider === "codex"
        ? agent.cli_reasoning_level || spawnModelConfig[provider]?.reasoningLevel || undefined
        : spawnModelConfig[provider]?.reasoningLevel || undefined;

    if (provider === "api") {
      const controller = new AbortController();
      const fakePid = getNextHttpAgentPid();
      db.prepare("UPDATE agents SET status = 'working' WHERE id = ?").run(id);
      db.prepare("UPDATE tasks SET status = 'in_progress', started_at = ?, updated_at = ? WHERE id = ?").run(
        nowMs(),
        nowMs(),
        taskId,
      );
      const updatedAgent = db.prepare("SELECT * FROM agents WHERE id = ?").get(id);
      broadcast("agent_status", updatedAgent);
      broadcast("task_update", db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId));
      notifyTaskStatus(taskId, task.title, "in_progress", taskLang);
      launchApiProviderAgent(
        taskId,
        agent.api_provider_id ?? null,
        agent.api_model ?? null,
        prompt,
        agentCwd,
        logPath,
        controller,
        fakePid,
      );
      return res.json({ ok: true, pid: fakePid, logPath, cwd: agentCwd });
    }

    if (provider === "copilot" || provider === "antigravity") {
      const controller = new AbortController();
      const fakePid = getNextHttpAgentPid();
      db.prepare("UPDATE agents SET status = 'working' WHERE id = ?").run(id);
      db.prepare("UPDATE tasks SET status = 'in_progress', started_at = ?, updated_at = ? WHERE id = ?").run(
        nowMs(),
        nowMs(),
        taskId,
      );
      const updatedAgent = db.prepare("SELECT * FROM agents WHERE id = ?").get(id);
      broadcast("agent_status", updatedAgent);
      broadcast("task_update", db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId));
      notifyTaskStatus(taskId, task.title, "in_progress", taskLang);
      launchHttpAgent(taskId, provider, prompt, agentCwd, logPath, controller, fakePid, agent.oauth_account_id ?? null);
      return res.json({ ok: true, pid: fakePid, logPath, cwd: agentCwd });
    }

    const spawnProfile = provider === "openclaw" ? agent.cli_profile || undefined : undefined;
    const child = spawnCliAgent(
      taskId,
      provider,
      prompt,
      agentCwd,
      logPath,
      spawnModel,
      spawnReasoningLevel,
      spawnProfile,
    );
    child.on("close", (code: number | null) => {
      handleTaskRunComplete(taskId, code ?? 1);
    });

    db.prepare("UPDATE agents SET status = 'working' WHERE id = ?").run(id);
    db.prepare("UPDATE tasks SET status = 'in_progress', started_at = ?, updated_at = ? WHERE id = ?").run(
      nowMs(),
      nowMs(),
      taskId,
    );

    const updatedAgent = db.prepare("SELECT * FROM agents WHERE id = ?").get(id);
    broadcast("agent_status", updatedAgent);
    broadcast("task_update", db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId));
    notifyTaskStatus(taskId, task.title, "in_progress", taskLang);

    res.json({ ok: true, pid: child.pid ?? null, logPath, cwd: agentCwd });
  });
}
