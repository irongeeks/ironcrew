import fs from "node:fs";
import path from "node:path";
import type { RuntimeContext } from "../../../types/runtime-context.ts";
import { getDepartmentPromptForPack } from "../packs/department-scope.ts";
import { ensureVideoPreprodRemotionBestPracticesSkill } from "../core/video-skill-bootstrap.ts";
import { inferRequestedServerType, requestServerAccess } from "./server-allocation.ts";
import {
  buildInterruptPromptBlock,
  consumeInterruptPrompts,
  loadPendingInterruptPrompts,
} from "../core/interrupt-injection-tools.ts";
import { buildDocsExecutionContextBlock } from "../../routes/docs/index.ts";
import { buildMcpToolsPromptBlock } from "../core/mcp-prompt-tools.ts";

type CreateExecutionStartTaskToolsDeps = {
  nowMs: RuntimeContext["nowMs"];
  db: RuntimeContext["db"];
  logsDir: RuntimeContext["logsDir"];
  appendTaskLog: RuntimeContext["appendTaskLog"];
  broadcast: RuntimeContext["broadcast"];
  ensureTaskExecutionSession: RuntimeContext["ensureTaskExecutionSession"];
  resolveLang: RuntimeContext["resolveLang"];
  notifyTaskStatus: (...args: any[]) => any;
  resolveProjectPath: RuntimeContext["resolveProjectPath"];
  createWorktree: RuntimeContext["createWorktree"];
  getDeptRoleConstraint: RuntimeContext["getDeptRoleConstraint"];
  getRecentConversationContext: RuntimeContext["getRecentConversationContext"];
  getTaskContinuationContext: RuntimeContext["getTaskContinuationContext"];
  getRecentChanges: RuntimeContext["getRecentChanges"];
  ensureClaudeMd: RuntimeContext["ensureClaudeMd"];
  pickL: RuntimeContext["pickL"];
  l: RuntimeContext["l"];
  buildAvailableSkillsPromptBlock: RuntimeContext["buildAvailableSkillsPromptBlock"];
  buildTaskExecutionPrompt: RuntimeContext["buildTaskExecutionPrompt"];
  hasExplicitWarningFixRequest: RuntimeContext["hasExplicitWarningFixRequest"];
  getNextHttpAgentPid: RuntimeContext["getNextHttpAgentPid"];
  launchApiProviderAgent: RuntimeContext["launchApiProviderAgent"];
  launchHttpAgent: RuntimeContext["launchHttpAgent"];
  getProviderModelConfig: RuntimeContext["getProviderModelConfig"];
  spawnCliAgent: RuntimeContext["spawnCliAgent"];
  handleTaskRunComplete: RuntimeContext["handleTaskRunComplete"];
  notifyCeo: RuntimeContext["notifyCeo"];
  startProgressTimer: RuntimeContext["startProgressTimer"];
  mcpManager?: RuntimeContext["mcpManager"];
};

export function createExecutionStartTaskTools(deps: CreateExecutionStartTaskToolsDeps) {
  const {
    nowMs,
    db,
    logsDir,
    appendTaskLog,
    broadcast,
    ensureTaskExecutionSession,
    resolveLang,
    notifyTaskStatus,
    resolveProjectPath,
    createWorktree,
    getDeptRoleConstraint,
    getRecentConversationContext,
    getTaskContinuationContext,
    getRecentChanges,
    ensureClaudeMd,
    pickL,
    l,
    buildAvailableSkillsPromptBlock,
    buildTaskExecutionPrompt,
    hasExplicitWarningFixRequest,
    getNextHttpAgentPid,
    launchApiProviderAgent,
    launchHttpAgent,
    getProviderModelConfig,
    spawnCliAgent,
    handleTaskRunComplete,
    notifyCeo,
    startProgressTimer,
    mcpManager,
  } = deps;

  function startTaskExecutionForAgent(taskId: string, execAgent: any, deptId: string | null, deptName: string): void {
    const execName = execAgent.name_ko || execAgent.name;
    const t = nowMs();
    db.prepare(
      "UPDATE tasks SET status = 'in_progress', assigned_agent_id = ?, started_at = ?, updated_at = ? WHERE id = ?",
    ).run(execAgent.id, t, t, taskId);
    db.prepare("UPDATE agents SET status = 'working', current_task_id = ? WHERE id = ?").run(taskId, execAgent.id);
    appendTaskLog(taskId, "system", `${execName} started (approved)`);

    broadcast("task_update", db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId));
    broadcast("agent_status", db.prepare("SELECT * FROM agents WHERE id = ?").get(execAgent.id));

    const provider = execAgent.cli_provider || "claude";
    if (!["claude", "codex", "gemini", "opencode", "copilot", "antigravity", "api", "openclaw"].includes(provider))
      return;
    const executionSession = ensureTaskExecutionSession(taskId, execAgent.id, provider);
    const pendingInterruptPrompts = loadPendingInterruptPrompts(db as any, taskId, executionSession.sessionId);
    const interruptPromptBlock = buildInterruptPromptBlock(pendingInterruptPrompts);

    const taskData = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as
      | {
          title: string;
          description: string | null;
          project_id: string | null;
          project_path: string | null;
          department_id: string | null;
          base_branch: string | null;
          workflow_pack_key: string | null;
          task_type: string | null;
          workflow_meta_json: string | null;
        }
      | undefined;
    if (!taskData) return;
    ensureVideoPreprodRemotionBestPracticesSkill({
      db: db as any,
      nowMs,
      workflowPackKey: taskData.workflow_pack_key,
      provider,
      taskId,
      appendTaskLog,
    });
    const taskLang = resolveLang(taskData.description ?? taskData.title);
    const requestedServerType = inferRequestedServerType({
      provider,
      taskType: taskData.task_type,
      workflowMetaJson: taskData.workflow_meta_json,
    });
    const serverAccess = requestServerAccess(db as any, {
      nowMs: nowMs(),
      taskId,
      agentId: execAgent.id,
      requestedServerType,
      queueReason: "execution_start",
    });
    if (serverAccess.state === "queued") {
      const rollbackAt = nowMs();
      appendTaskLog(
        taskId,
        "system",
        `Server queued: requested=${serverAccess.requested_server_type}, queue_position=${serverAccess.queue_position}. task moved to pending.`,
      );
      db.prepare("UPDATE tasks SET status = 'pending', started_at = NULL, updated_at = ? WHERE id = ?").run(
        rollbackAt,
        taskId,
      );
      db.prepare(
        "UPDATE agents SET status = 'idle', current_task_id = CASE WHEN current_task_id = ? THEN NULL ELSE current_task_id END WHERE id = ?",
      ).run(taskId, execAgent.id);
      broadcast("task_update", db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId));
      broadcast("agent_status", db.prepare("SELECT * FROM agents WHERE id = ?").get(execAgent.id));
      notifyTaskStatus(taskId, taskData.title, "pending", taskLang);
      notifyCeo(
        pickL(
          l(
            [
              `'${taskData.title}' 서버 리소스 대기열에 등록되었습니다. (${serverAccess.requested_server_type}, 대기 ${serverAccess.queue_position}번)`,
            ],
            [
              `'${taskData.title}' is queued for server resources (${serverAccess.requested_server_type}, position ${serverAccess.queue_position}).`,
            ],
            [
              `'${taskData.title}' はサーバーリソース待ちキューに登録されました（${serverAccess.requested_server_type}, ${serverAccess.queue_position}番目）。`,
            ],
            [
              `'${taskData.title}' 已进入服务器资源队列（${serverAccess.requested_server_type}，排队第 ${serverAccess.queue_position} 位）。`,
            ],
          ),
          taskLang,
        ),
        taskId,
      );
      return;
    }
    if (serverAccess.state === "allocated") {
      appendTaskLog(
        taskId,
        "system",
        `Server allocated: type=${serverAccess.requested_server_type}, server_id=${serverAccess.server_id}`,
      );
      broadcast("server_update", { action: "allocation_activated", task_id: taskId, allocation: serverAccess });
    }
    let sshGuidance = "";
    try {
      const alloc = (db as any)
        .prepare(
          "SELECT sa.server_id, s.id, s.name, s.ssh_config_json FROM server_allocations sa JOIN servers s ON s.id = sa.server_id WHERE sa.task_id = ? AND sa.status = 'active' AND s.ssh_config_json IS NOT NULL LIMIT 1",
        )
        .get(taskId) as { id: string; name: string; ssh_config_json: string } | undefined;
      if (alloc) {
        try {
          const sshCfg = JSON.parse(alloc.ssh_config_json) as { host?: string; port?: number; user?: string };
          // Validate SSH config fields to prevent injection into guidance text
          const host = typeof sshCfg.host === "string" ? sshCfg.host.replace(/[^a-zA-Z0-9.\-:]/g, "") : "";
          const user = typeof sshCfg.user === "string" ? sshCfg.user.replace(/[^a-zA-Z0-9_\-.]/g, "") : "user";
          const port = typeof sshCfg.port === "number" && sshCfg.port >= 1 && sshCfg.port <= 65535 ? sshCfg.port : 22;
          if (host) {
            sshGuidance = `\n[SSH Server] ${alloc.name}: ssh ${user}@${host}${port !== 22 ? `:${port}` : ""}`;
          }
        } catch {
          // best-effort
        }
      }
    } catch {
      // best-effort: table may not exist in older DBs
    }
    notifyTaskStatus(taskId, taskData.title, "in_progress", taskLang);

    let projPath = resolveProjectPath(taskData);
    if (!projPath) {
      // Auto-create a workspace directory for tasks without an explicit project path
      const slug = taskData.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 40);
      const workspaceDir = path.join(process.cwd(), "workspaces", `${slug}-${taskId.slice(0, 8)}`);
      fs.mkdirSync(workspaceDir, { recursive: true });
      projPath = workspaceDir;
      db.prepare("UPDATE tasks SET project_path = ?, updated_at = ? WHERE id = ?").run(workspaceDir, nowMs(), taskId);
      appendTaskLog(taskId, "system", `Auto-assigned workspace: ${workspaceDir}`);
    }
    let agentCwd: string;
    let worktreePath: string = projPath;
    const isGitRepo = fs.existsSync(path.join(projPath, ".git"));
    if (!isGitRepo) {
      // Non-git workspace (e.g. video output dirs) — use directly, no worktree needed
      agentCwd = projPath;
      appendTaskLog(taskId, "system", `Using project path directly (not a git repo): ${projPath}`);
    } else {
      const wtPath = createWorktree(projPath, taskId, execAgent.name, taskData.base_branch ?? undefined);
      if (!wtPath) {
        const rollbackAt = nowMs();
        appendTaskLog(
          taskId,
          "error",
          `Execution blocked: isolated worktree creation failed for project path '${projPath}'`,
        );
        db.prepare("UPDATE tasks SET status = 'pending', started_at = NULL, updated_at = ? WHERE id = ?").run(
          rollbackAt,
          taskId,
        );
        db.prepare(
          "UPDATE agents SET status = 'idle', current_task_id = CASE WHEN current_task_id = ? THEN NULL ELSE current_task_id END WHERE id = ?",
        ).run(taskId, execAgent.id);
        broadcast("task_update", db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId));
        broadcast("agent_status", db.prepare("SELECT * FROM agents WHERE id = ?").get(execAgent.id));
        notifyTaskStatus(taskId, taskData.title, "pending", taskLang);
        notifyCeo(
          pickL(
            l(
              [
                `[WORKTREE REQUIRED] '${taskData.title}' 실행을 차단했습니다. 격리 worktree 생성에 실패해 프로젝트 루트 오염을 방지하기 위해 중단되었습니다.`,
              ],
              [
                `[WORKTREE REQUIRED] Blocked execution for '${taskData.title}'. Isolated worktree creation failed, so run was aborted to protect the project root.`,
              ],
              [
                `[WORKTREE REQUIRED] '${taskData.title}' の実行を停止しました。分離 worktree 作成に失敗したため、プロジェクトルート保護のため中断しました。`,
              ],
              [
                `[WORKTREE REQUIRED] 已阻止 '${taskData.title}' 的执行。由于隔离 worktree 创建失败，为保护项目根目录已中止。`,
              ],
            ),
            taskLang,
          ),
          taskId,
        );
        return;
      }
      worktreePath = wtPath;
      agentCwd = wtPath;
      appendTaskLog(taskId, "system", `Git worktree created: ${wtPath} (branch: ironcrew/${taskId.slice(0, 8)})`);
    }
    const docsContext = buildDocsExecutionContextBlock({
      db: db as any,
      task: {
        id: taskId,
        project_id: taskData.project_id,
        project_path: taskData.project_path,
      },
      worktreePath,
      appendTaskLog,
    });
    const logFilePath = path.join(logsDir, `${taskId}.log`);
    const roleLabels: Record<string, string> = {
      team_leader: "Team Leader",
      senior: "Senior",
      junior: "Junior",
      intern: "Intern",
    };
    const roleLabel = roleLabels[execAgent.role] ?? execAgent.role;
    const deptConstraint = deptId ? getDeptRoleConstraint(deptId, deptName) : "";
    const deptPromptRaw = deptId ? getDepartmentPromptForPack(db as any, taskData.workflow_pack_key, deptId) : null;
    const deptPrompt = typeof deptPromptRaw === "string" ? deptPromptRaw.trim() : "";
    const deptPromptBlock = deptPrompt ? `[Department Shared Prompt]\n${deptPrompt}` : "";
    const conversationCtx = getRecentConversationContext(execAgent.id);
    const continuationCtx = getTaskContinuationContext(taskId);
    const recentChanges = getRecentChanges(projPath, taskId);
    if (provider === "claude") {
      ensureClaudeMd(projPath, worktreePath);
    }
    const continuationInstruction = continuationCtx
      ? pickL(
          l(
            ["연속 실행: 소유 컨텍스트를 유지하고 인사/착수 멘트 없이 미해결 검토 항목을 즉시 반영하세요."],
            [
              "Continuation run: keep ownership, skip greetings/kickoff narration, and execute unresolved review items immediately.",
            ],
            ["継続実行: オーナーシップを維持し、挨拶/開始ナレーションなしで未解決レビュー項目を即時反映してください。"],
            ["连续执行：保持责任上下文，跳过问候/开场说明，立即处理未解决评审项。"],
          ),
          taskLang,
        )
      : pickL(
          l(
            ["긴 서론 없이 바로 실행하고, 메시지는 간결하게 유지하세요."],
            ["Execute directly without long preamble and keep messages concise."],
            ["長い前置きなしで直ちに実行し、メッセージは簡潔にしてください。"],
            ["无需冗长前言，直接执行并保持消息简洁。"],
          ),
          taskLang,
        );
    const runInstruction = pickL(
      l(
        ["위 작업을 충분히 완수하세요. 필요 시 연속 실행 요약과 대화 맥락을 참고하세요."],
        [
          "Please complete the task above thoroughly. Use the continuation brief and conversation context above if relevant.",
        ],
        ["上記タスクを丁寧に完了してください。必要に応じて継続要約と会話コンテキストを参照してください。"],
        ["请完整地完成上述任务。可按需参考连续执行摘要与会话上下文。"],
      ),
      taskLang,
    );
    const availableSkillsPromptBlock = buildAvailableSkillsPromptBlock(provider);

    const mcpToolsBlock = buildMcpToolsPromptBlock(mcpManager);

    const spawnPrompt = buildTaskExecutionPrompt(
      [
        availableSkillsPromptBlock,
        `[Task Session] id=${executionSession.sessionId} owner=${executionSession.agentId} provider=${executionSession.provider}`,
        "This session is scoped to this task only. Keep context continuity inside this task session and do not mix with other projects.",
        docsContext.contextBlock ? `\n[Obsidian Docs Context]\n${docsContext.contextBlock}` : "",
        recentChanges ? `[Recent Changes]\n${recentChanges}` : "",
        `[Task] ${taskData.title}`,
        taskData.description ? `\n${taskData.description}` : "",
        sshGuidance,
        mcpToolsBlock,
        continuationCtx,
        conversationCtx,
        `\n---`,
        `Agent: ${execAgent.name} (${roleLabel}, ${deptName})`,
        execAgent.personality ? `Personality: ${execAgent.personality}` : "",
        deptConstraint,
        deptPromptBlock,
        `NOTE: You are working in an isolated Git worktree branch (ironcrew/${taskId.slice(0, 8)}). Commit your changes normally.`,
        interruptPromptBlock,
        continuationInstruction,
        runInstruction,
      ],
      {
        allowWarningFix: hasExplicitWarningFixRequest(taskData.title, taskData.description),
      },
    );

    if (pendingInterruptPrompts.length > 0) {
      consumeInterruptPrompts(
        db as any,
        pendingInterruptPrompts.map((row) => row.id),
        nowMs(),
      );
      appendTaskLog(
        taskId,
        "system",
        `INJECT consumed (${pendingInterruptPrompts.length}) for session ${executionSession.sessionId}`,
      );
    }

    appendTaskLog(taskId, "system", `RUN start (agent=${execAgent.name}, provider=${provider})`);
    if (provider === "api") {
      const controller = new AbortController();
      const fakePid = getNextHttpAgentPid();
      launchApiProviderAgent(
        taskId,
        execAgent.api_provider_id ?? null,
        execAgent.api_model ?? null,
        spawnPrompt,
        agentCwd,
        logFilePath,
        controller,
        fakePid,
      );
    } else if (provider === "copilot" || provider === "antigravity") {
      const controller = new AbortController();
      const fakePid = getNextHttpAgentPid();
      launchHttpAgent(
        taskId,
        provider,
        spawnPrompt,
        agentCwd,
        logFilePath,
        controller,
        fakePid,
        execAgent.oauth_account_id ?? null,
      );
    } else {
      const modelConfig = getProviderModelConfig();
      const modelForProvider = execAgent.cli_model || modelConfig[provider]?.model || undefined;
      const reasoningLevel =
        provider === "codex"
          ? execAgent.cli_reasoning_level || modelConfig[provider]?.reasoningLevel || undefined
          : modelConfig[provider]?.reasoningLevel || undefined;
      const profile = provider === "openclaw" ? execAgent.cli_profile || undefined : undefined;
      const child = spawnCliAgent(
        taskId,
        provider,
        spawnPrompt,
        agentCwd,
        logFilePath,
        modelForProvider,
        reasoningLevel,
        profile,
      );
      child.on("close", (code: number | null) => {
        handleTaskRunComplete(taskId, code ?? 1);
      });
    }

    const worktreeNote = pickL(
      l(
        [` (격리 브랜치: ironcrew/${taskId.slice(0, 8)})`],
        [` (isolated branch: ironcrew/${taskId.slice(0, 8)})`],
        [` (分離ブランチ: ironcrew/${taskId.slice(0, 8)})`],
        [`（隔离分支: ironcrew/${taskId.slice(0, 8)}）`],
      ),
      taskLang,
    );
    notifyCeo(
      pickL(
        l(
          [`${execName}가 '${taskData.title}' 작업을 시작했습니다.${worktreeNote}`],
          [`${execName} started work on '${taskData.title}'.${worktreeNote}`],
          [`${execName}が '${taskData.title}' の作業を開始しました。${worktreeNote}`],
          [`${execName} 已开始处理 '${taskData.title}'。${worktreeNote}`],
        ),
        taskLang,
      ),
      taskId,
    );
    startProgressTimer(taskId, taskData.title, deptId);
  }

  return {
    startTaskExecutionForAgent,
  };
}
