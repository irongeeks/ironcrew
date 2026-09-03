import fs from "node:fs";
import path from "node:path";
import { notifyTaskStatus } from "../../../../gateway/client.ts";
import type { RuntimeContext } from "../../../../types/runtime-context.ts";
import type { AgentRow } from "../../shared/types.ts";
import type { PackRegistry } from "../../../../packs/pack-registry.ts";
import type { GraphRunner } from "../../../workflow/orchestration/graph-runner.ts";
import { buildMcpToolsPromptBlock } from "../../../workflow/core/mcp-prompt-tools.ts";
import { wrapDatabaseSync } from "../../../workflow/orchestration/graph-runner.ts";
import {
  resolveConstrainedAgentScopeForTask,
  selectAutoAssignableAgentForTask,
  selectAgentForDepartment,
} from "./execution-run-auto-assign.ts";
import {
  parseWorkflowMeta,
  updateWorkflowMeta,
  hasPipeline,
  getCurrentPipelineDept,
  getPipelineStepPromptPrefix,
  buildPipelineContextBlock,
} from "../../../workflow/orchestration/pipeline-helpers.ts";
import { buildRelatedTaskContextBlock } from "../../../workflow/orchestration/context-sharing.ts";
import {
  parseClaudeMd,
  selectSectionsForDepartment,
  buildProjectContextPromptBlock,
} from "../../../workflow/core/claude-md-parser.ts";
import { resolveAgentRouting } from "../../../workflow/orchestration/agent-routing.ts";
import { ensureVideoPreprodRemotionBestPracticesSkill } from "../../../workflow/core/video-skill-bootstrap.ts";
import {
  buildInterruptPromptBlock,
  consumeInterruptPrompts,
  loadPendingInterruptPrompts,
} from "../../../workflow/core/interrupt-injection-tools.ts";
import { buildDocsExecutionContextBlock } from "../../docs/index.ts";
import { logger } from "../../../../observability/logger.ts";
const log = logger.child({ module: "execution-run" });

export type TaskRunRouteDeps = Pick<
  RuntimeContext,
  | "app"
  | "db"
  | "activeProcesses"
  | "appendTaskLog"
  | "nowMs"
  | "resolveLang"
  | "ensureTaskExecutionSession"
  | "resolveProjectPath"
  | "logsDir"
  | "createWorktree"
  | "generateProjectContext"
  | "getRecentChanges"
  | "ensureClaudeMd"
  | "getDeptRoleConstraint"
  | "normalizeTextField"
  | "getRecentConversationContext"
  | "getTaskContinuationContext"
  | "pickL"
  | "l"
  | "getProviderModelConfig"
  | "buildTaskExecutionPrompt"
  | "hasExplicitWarningFixRequest"
  | "getNextHttpAgentPid"
  | "broadcast"
  | "getAgentDisplayName"
  | "notifyCeo"
  | "startProgressTimer"
  | "launchApiProviderAgent"
  | "launchHttpAgent"
  | "spawnCliAgent"
  | "handleTaskRunComplete"
  | "buildAvailableSkillsPromptBlock"
> & {
  packRegistry?: PackRegistry;
  graphRunner?: GraphRunner;
  mcpManager?: RuntimeContext["mcpManager"];
};

const taskLaunchLocks = new Set<string>();

export function registerTaskRunRoute(deps: TaskRunRouteDeps): void {
  const {
    app,
    db,
    activeProcesses,
    appendTaskLog,
    nowMs,
    resolveLang,
    ensureTaskExecutionSession,
    resolveProjectPath,
    logsDir,
    createWorktree,
    generateProjectContext,
    getRecentChanges,
    ensureClaudeMd,
    getDeptRoleConstraint,
    normalizeTextField,
    getRecentConversationContext,
    getTaskContinuationContext,
    pickL,
    l,
    getProviderModelConfig,
    buildTaskExecutionPrompt,
    hasExplicitWarningFixRequest,
    getNextHttpAgentPid,
    broadcast,
    getAgentDisplayName,
    notifyCeo,
    startProgressTimer,
    launchApiProviderAgent,
    launchHttpAgent,
    spawnCliAgent,
    handleTaskRunComplete,
    buildAvailableSkillsPromptBlock,
    packRegistry,
    graphRunner,
    mcpManager,
  } = deps;

  app.post("/api/tasks/:id/run", async (req, res) => {
    const id = String(req.params.id);
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
      | {
          id: string;
          title: string;
          description: string | null;
          assigned_agent_id: string | null;
          department_id: string | null;
          project_id: string | null;
          workflow_pack_key: string | null;
          project_path: string | null;
          status: string;
          task_type: string | null;
          workflow_meta_json: string | null;
        }
      | undefined;
    if (!task) return res.status(404).json({ error: "not_found" });
    const taskLang = resolveLang(task.description ?? task.title);

    if (activeProcesses.has(id)) {
      const staleChild = activeProcesses.get(id);
      const stalePid = typeof staleChild?.pid === "number" ? staleChild.pid : null;
      let pidIsAlive = false;
      if (stalePid !== null && stalePid > 0) {
        try {
          process.kill(stalePid, 0);
          pidIsAlive = true;
        } catch {
          pidIsAlive = false;
        }
      }
      if (!pidIsAlive) {
        activeProcesses.delete(id);
        appendTaskLog(id, "system", `Cleaned up stale process handle (pid=${stalePid}) on re-run attempt`);
      }
    }

    if (task.status === "in_progress" || task.status === "collaborating") {
      if (activeProcesses.has(id)) {
        return res.status(400).json({ error: "already_running" });
      }
      const t = nowMs();
      db.prepare("UPDATE tasks SET status = 'pending', updated_at = ? WHERE id = ?").run(t, id);
      task.status = "pending";
      appendTaskLog(id, "system", `Reset stale in_progress status (no active process) for re-run`);
    }

    if (activeProcesses.has(id)) {
      return res.status(409).json({
        error: "process_still_active",
        message: "Previous run is still stopping. Please retry after a moment.",
      });
    }

    if (taskLaunchLocks.has(id)) {
      return res.status(409).json({ error: "launch_in_progress" });
    }
    taskLaunchLocks.add(id);

    try {
      let agentId = task.assigned_agent_id || (req.body?.agent_id as string | undefined);
      if (agentId) {
        const constrainedAgentIds = resolveConstrainedAgentScopeForTask(db as any, {
          workflow_pack_key: task.workflow_pack_key,
          department_id: task.department_id,
          project_id: task.project_id,
        });
        if (
          Array.isArray(constrainedAgentIds) &&
          constrainedAgentIds.length > 0 &&
          !constrainedAgentIds.includes(agentId)
        ) {
          appendTaskLog(
            id,
            "system",
            `Assigned agent (${agentId}) is out of scope for workflow pack. Re-selecting by pack rules.`,
          );
          agentId = undefined;
        }
      }
      if (!agentId) {
        const autoSelected = selectAutoAssignableAgentForTask(db as any, {
          workflow_pack_key: task.workflow_pack_key,
          department_id: task.department_id,
          project_id: task.project_id,
        });
        if (autoSelected) {
          agentId = autoSelected.agent.id;
          const assignedAt = nowMs();
          db.prepare(
            "UPDATE tasks SET assigned_agent_id = ?, department_id = COALESCE(department_id, ?), status = CASE WHEN status = 'inbox' THEN 'planned' ELSE status END, updated_at = ? WHERE id = ?",
          ).run(agentId, autoSelected.agent.department_id, assignedAt, id);
          db.prepare("UPDATE agents SET current_task_id = ? WHERE id = ?").run(id, agentId);
          appendTaskLog(
            id,
            "system",
            `Auto-assigned by workflow pack (${autoSelected.packKey}): ${autoSelected.agent.name}`,
          );
        }
      }
      if (!agentId) {
        return res.status(400).json({
          error: "no_agent_assigned",
          message: "Assign an agent before running.",
        });
      }

      // ── Pipeline Step Interception ──
      // If a department pipeline is configured, route to the correct department's agent
      const workflowMeta = parseWorkflowMeta(task.workflow_meta_json);
      if (hasPipeline(workflowMeta)) {
        const pipeline = workflowMeta.pipeline;
        const currentDept = getCurrentPipelineDept(pipeline);
        if (currentDept) {
          // Save original agent on first pipeline entry
          if (pipeline.current_step === 0 && !pipeline.original_agent_id) {
            pipeline.original_agent_id = agentId;
            updateWorkflowMeta(db as any, id, { pipeline }, nowMs());
          }

          // Check if current agent is in the correct department
          const currentAgentDept = (
            db.prepare("SELECT department_id FROM agents WHERE id = ?").get(agentId) as
              | { department_id: string | null }
              | undefined
          )?.department_id;

          if (currentAgentDept !== currentDept) {
            // Need to reassign to an agent in the pipeline's current department
            const deptResult = selectAgentForDepartment(
              db as any,
              {
                workflow_pack_key: task.workflow_pack_key,
                department_id: currentDept,
                project_id: task.project_id,
              },
              currentDept,
            );

            if (deptResult) {
              agentId = deptResult.agent.id;
              const t = nowMs();
              db.prepare("UPDATE tasks SET assigned_agent_id = ?, department_id = ?, updated_at = ? WHERE id = ?").run(
                agentId,
                currentDept,
                t,
                id,
              );
              appendTaskLog(
                id,
                "system",
                `Pipeline step ${pipeline.current_step + 1}/${pipeline.steps.length}: routed to ${deptResult.agent.name} (${currentDept})`,
              );
            } else {
              appendTaskLog(
                id,
                "system",
                `Pipeline: no available agent in department '${currentDept}', proceeding with current agent`,
              );
            }
          }
        }
      }

      let agent:
        | {
            id: string;
            name: string;
            name_ko: string | null;
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
            department_name_ko: string | null;
            department_prompt: string | null;
          }
        | undefined;
      try {
        agent = db
          .prepare(
            `
      SELECT
        a.*,
        COALESCE(opd.name, d.name) AS department_name,
        COALESCE(opd.name_ko, d.name_ko) AS department_name_ko,
        COALESCE(opd.prompt, d.prompt) AS department_prompt
      FROM agents a
      LEFT JOIN office_pack_departments opd
        ON opd.workflow_pack_key = COALESCE(?, 'development')
       AND opd.department_id = a.department_id
      LEFT JOIN departments d ON a.department_id = d.id
      WHERE a.id = ?
    `,
          )
          .get(task.workflow_pack_key, agentId) as
          | {
              id: string;
              name: string;
              name_ko: string | null;
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
              department_name_ko: string | null;
              department_prompt: string | null;
            }
          | undefined;
      } catch {
        agent = db
          .prepare(
            `
      SELECT a.*, d.name AS department_name, d.name_ko AS department_name_ko, d.prompt AS department_prompt
      FROM agents a LEFT JOIN departments d ON a.department_id = d.id
      WHERE a.id = ?
    `,
          )
          .get(agentId) as
          | {
              id: string;
              name: string;
              name_ko: string | null;
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
              department_name_ko: string | null;
              department_prompt: string | null;
            }
          | undefined;
      }
      if (!agent) return res.status(400).json({ error: "agent_not_found" });

      const agentBusy = activeProcesses.has(
        (
          db.prepare("SELECT current_task_id FROM agents WHERE id = ? AND status = 'working'").get(agentId) as
            | { current_task_id: string | null }
            | undefined
        )?.current_task_id ?? "",
      );
      if (agentBusy) {
        return res
          .status(400)
          .json({ error: "agent_busy", message: `${agent.name} is already working on another task.` });
      }

      const provider = agent.cli_provider || "claude";
      if (!["claude", "codex", "gemini", "opencode", "copilot", "antigravity", "api", "openclaw"].includes(provider)) {
        return res.status(400).json({ error: "unsupported_provider", provider });
      }
      ensureVideoPreprodRemotionBestPracticesSkill({
        db: db as any,
        nowMs,
        workflowPackKey: task.workflow_pack_key,
        provider,
        taskId: id,
        appendTaskLog,
      });
      const executionSession = ensureTaskExecutionSession(id, agentId, provider);
      const pendingInterruptPrompts = loadPendingInterruptPrompts(db as any, id, executionSession.sessionId);
      const interruptPromptBlock = buildInterruptPromptBlock(pendingInterruptPrompts);

      let projectPath = resolveProjectPath(task) || task.project_path || null;
      if (!projectPath) {
        // Auto-create a workspace directory for tasks without an explicit project path
        // Use pack's default_workspace if available, otherwise fall back to "workspaces"
        let baseDir = "workspaces";
        if (task.workflow_pack_key && deps.packRegistry) {
          try {
            const loadedPack = deps.packRegistry.get(task.workflow_pack_key);
            const defaultWs = loadedPack?.definition?.staff?.default_workspace;
            // A-001 (#88): pack-schema rejects traversal in default_workspace
            // at load time. Defence-in-depth: also enforce the same shape
            // here in case a hostile DB write or a schema bypass slips
            // through. Anything outside the safe shape silently falls back
            // to "workspaces" rather than escaping process.cwd().
            if (defaultWs && /^[a-z0-9_-]+(\/[a-z0-9_-]+)*$/.test(defaultWs) && !defaultWs.includes("..")) {
              baseDir = defaultWs;
            }
          } catch {
            // pack not found — use default
          }
        }
        const slug = task.title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 40);
        const workspaceDir = path.join(process.cwd(), baseDir, `${slug}-${id.slice(0, 8)}`);
        fs.mkdirSync(workspaceDir, { recursive: true });
        projectPath = workspaceDir;
        // Persist the auto-assigned path so subsequent runs reuse it
        db.prepare("UPDATE tasks SET project_path = ?, updated_at = ? WHERE id = ?").run(workspaceDir, nowMs(), id);
        appendTaskLog(id, "system", `Auto-assigned workspace: ${workspaceDir}`);
      }
      const logPath = path.join(logsDir, `${id}.log`);

      let agentCwd: string;
      const isGitRepo = fs.existsSync(path.join(projectPath, ".git"));
      if (!isGitRepo) {
        // Non-git project (e.g. video output dirs) — use project path directly, no worktree needed
        agentCwd = projectPath;
        appendTaskLog(id, "system", `Using project path directly (not a git repo): ${projectPath}`);
      } else {
        const worktreePath = createWorktree(projectPath, id, agent.name);
        if (!worktreePath) {
          appendTaskLog(
            id,
            "error",
            `Execution blocked: isolated worktree creation failed for project path '${projectPath}'`,
          );
          return res.status(409).json({
            error: "worktree_required",
            message: "Isolated worktree creation failed. Task execution was blocked to protect the project root.",
          });
        }
        agentCwd = worktreePath;
        appendTaskLog(id, "system", `Git worktree created: ${worktreePath} (branch: octooffice/${id.slice(0, 8)})`);
      }

      const docsContext = buildDocsExecutionContextBlock({
        db: db as any,
        task,
        worktreePath: agentCwd,
        appendTaskLog,
      });

      const projectContext = generateProjectContext(projectPath);
      const recentChanges = getRecentChanges(projectPath, id);

      if (provider === "claude") {
        ensureClaudeMd(projectPath, agentCwd);
      }

      // Build phase-aware project context from CLAUDE.md
      let projectContextBlock = "";
      try {
        const claudeMdPath = path.join(agentCwd, "CLAUDE.md");
        if (fs.existsSync(claudeMdPath)) {
          const claudeMdContent = fs.readFileSync(claudeMdPath, "utf-8");
          const parsed = parseClaudeMd(claudeMdContent);
          if (parsed.title) {
            // Determine current phase department for selective injection
            let phaseDept: string | null = null;
            if ((task as any).workflow_pack_key && packRegistry) {
              try {
                const pack = packRegistry.get((task as any).workflow_pack_key);
                const currentPhaseSubtask = (db as any)
                  .prepare(
                    "SELECT title FROM subtasks WHERE task_id = ? AND title LIKE '[pipeline:%' AND status IN ('pending', 'in_progress') ORDER BY created_at ASC LIMIT 1",
                  )
                  .get(id) as { title?: string } | undefined;
                if (currentPhaseSubtask?.title) {
                  const phaseMatch = currentPhaseSubtask.title.match(/^\[pipeline:([^\]:]+)/);
                  if (phaseMatch) {
                    const phaseId = phaseMatch[1];
                    const phase = pack.graph.phases.find((p: any) => p.id === phaseId);
                    phaseDept = phase?.department ?? null;
                  }
                }
              } catch {
                /* pack not found */
              }
            }
            const selected = selectSectionsForDepartment(parsed.sections, phaseDept);
            projectContextBlock = buildProjectContextPromptBlock(parsed.title, selected);
          }
        }
      } catch {
        // CLAUDE.md read error — skip
      }

      const roleLabel =
        { team_leader: "Team Leader", senior: "Senior", junior: "Junior", intern: "Intern" }[agent.role] || agent.role;
      const effectiveRouting = resolveAgentRouting(
        {
          agent_routing: (task as any).agent_routing ?? null,
          workflow_pack_key: (task as any).workflow_pack_key ?? null,
        },
        packRegistry ?? null,
      );
      const deptConstraint =
        effectiveRouting === "single"
          ? ""
          : agent.department_id
            ? getDeptRoleConstraint(agent.department_id, agent.department_name || agent.department_id)
            : "";
      const departmentPrompt = effectiveRouting === "single" ? "" : normalizeTextField(agent.department_prompt);
      const departmentPromptBlock = departmentPrompt ? `[Department Shared Prompt]\n${departmentPrompt}` : "";
      const conversationCtx = getRecentConversationContext(agentId);
      const continuationCtx = getTaskContinuationContext(id);
      const continuationInstruction = continuationCtx
        ? pickL(
            l(
              ["연속 실행: 동일 소유 컨텍스트를 유지하고, 불필요한 파일 재탐색 없이 미해결 항목만 반영하세요."],
              [
                "Continuation run: keep the same ownership context, avoid re-reading unrelated files, and apply only unresolved deltas.",
              ],
              ["継続実行: 同一オーナーシップを維持し、不要な再探索を避けて未解決差分のみ反映してください。"],
              ["连续执行：保持同一责任上下文，避免重复阅读无关文件，仅处理未解决差异。"],
            ),
            taskLang,
          )
        : pickL(
            l(
              ["반복적인 착수 멘트 없이 바로 실행하세요."],
              ["Execute directly without repeated kickoff narration."],
              ["繰り返しの開始ナレーションなしで直ちに実行してください。"],
              ["无需重复开场说明，直接执行。"],
            ),
            taskLang,
          );
      const projectStructureBlock = continuationCtx
        ? ""
        : projectContext
          ? `[Project Structure]\n${projectContext.length > 4000 ? projectContext.slice(0, 4000) + "\n... (truncated)" : projectContext}`
          : "";
      const needsPlanInstruction = provider === "gemini" || provider === "copilot" || provider === "antigravity";
      const subtaskInstruction = needsPlanInstruction
        ? `\n\n${pickL(
            l(
              [
                `[작업 계획 출력 규칙]
작업을 시작하기 전에 아래 JSON 형식으로 계획을 출력하세요:
\`\`\`json
{"subtasks": [{"title": "서브태스크 제목1"}, {"title": "서브태스크 제목2"}]}
\`\`\`
각 서브태스크를 완료할 때마다 아래 형식으로 보고하세요:
\`\`\`json
{"subtask_done": "완료된 서브태스크 제목"}
\`\`\``,
              ],
              [
                `[Task Plan Output Rules]
Before starting work, print a plan in the JSON format below:
\`\`\`json
{"subtasks": [{"title": "Subtask title 1"}, {"title": "Subtask title 2"}]}
\`\`\`
Whenever you complete a subtask, report it in this format:
\`\`\`json
{"subtask_done": "Completed subtask title"}
\`\`\``,
              ],
              [
                `[作業計画の出力ルール]
作業開始前に、次の JSON 形式で計画を出力してください:
\`\`\`json
{"subtasks": [{"title": "サブタスク1"}, {"title": "サブタスク2"}]}
\`\`\`
各サブタスクを完了するたびに、次の形式で報告してください:
\`\`\`json
{"subtask_done": "完了したサブタスク"}
\`\`\``,
              ],
              [
                `[任务计划输出规则]
开始工作前，请按下述 JSON 格式输出计划:
\`\`\`json
{"subtasks": [{"title": "子任务1"}, {"title": "子任务2"}]}
\`\`\`
每完成一个子任务，请按下述格式汇报:
\`\`\`json
{"subtask_done": "已完成的子任务"}
\`\`\``,
              ],
            ),
            taskLang,
          )}\n`
        : "";

      const modelConfig = getProviderModelConfig();
      const mainModel = agent.cli_model || modelConfig[provider]?.model || undefined;
      const subModel = modelConfig[provider]?.subModel || undefined;
      const mainReasoningLevel =
        provider === "codex"
          ? agent.cli_reasoning_level || modelConfig[provider]?.reasoningLevel || undefined
          : modelConfig[provider]?.reasoningLevel || undefined;
      const subReasoningLevel = modelConfig[provider]?.subModelReasoningLevel || undefined;
      const subModelHint =
        subModel && (provider === "claude" || provider === "codex")
          ? `\n[Sub-agent model preference] When spawning sub-agents (Task tool), prefer using model: ${subModel}${subReasoningLevel ? ` with reasoning effort: ${subReasoningLevel}` : ""}`
          : "";
      const runInstruction = pickL(
        l(
          [
            "위 작업을 충분히 완수하세요. 위 대화 맥락과 프로젝트 구조를 참고해도 좋지만, 프로젝트 구조 탐색에 시간을 쓰지 마세요. 필요한 구조는 이미 제공되었습니다.",
          ],
          [
            "Please complete the task above thoroughly. Use the continuation brief, conversation context, and project structure above if relevant. Do NOT spend time exploring the project structure again unless required by unresolved checklist items.",
          ],
          [
            "上記タスクを丁寧に完了してください。必要に応じて継続要約・会話コンテキスト・プロジェクト構成を参照できますが、未解決チェックリストに必要な場合を除き、構成探索に時間を使わないでください。",
          ],
          [
            "请完整地完成上述任务。可按需参考连续执行摘要、会话上下文和项目结构，但除非未解决清单确有需要，不要再次花时间探索项目结构。",
          ],
        ),
        taskLang,
      );
      // ── Graph-runner seeding path ──
      // Delegate subtask seeding to the graph runner for registered packs.
      // ONLY seed if no pipeline subtasks exist yet (prevents duplicate seeding on rerun).
      if (task.workflow_pack_key && packRegistry && graphRunner) {
        let registryPack: import("../../../../packs/pack-loader.ts").LoadedPack | null = null;
        try {
          registryPack = packRegistry.get(task.workflow_pack_key);
        } catch {
          // pack not in registry — no seeding
        }
        if (registryPack) {
          const existingPipelineSubtasks = (db as any)
            .prepare("SELECT COUNT(*) as cnt FROM subtasks WHERE task_id = ? AND title LIKE '[pipeline:%'")
            .get(id) as { cnt: number } | undefined;
          if (!existingPipelineSubtasks || existingPipelineSubtasks.cnt === 0) {
            const taskInput: Record<string, unknown> = {};
            try {
              const meta = task.workflow_meta_json ? JSON.parse(task.workflow_meta_json) : {};
              Object.assign(taskInput, meta);
            } catch (err) {
              log.warn(
                { err, taskId: id, field: "workflow_meta_json", operation: "parse_workflow_meta" },
                "malformed workflow_meta_json, using fallback",
              );
            }
            if (task.title) taskInput.title = task.title;
            if (task.description) taskInput.description = task.description;
            try {
              await graphRunner.seedSubtasks(wrapDatabaseSync(db), id, registryPack, taskInput);
              appendTaskLog(id, "system", `Graph-runner: seeded ${registryPack.graph.phases.length} pipeline phases`);
            } catch (err) {
              const stack = err instanceof Error ? err.stack : String(err);
              appendTaskLog(id, "error", `Graph-runner seeding failed: ${stack}`);
            }
          }

          // Auto-dispatch any pending phases that use node_type.
          // node-type phases run directly without spawning an agent.
          // This call is idempotent — it only advances phases that are pending and ready.
          try {
            const { dispatched, taskDone } = await graphRunner.dispatchAutoPhases(
              wrapDatabaseSync(db),
              id,
              registryPack,
              projectPath ?? process.cwd(),
            );
            if (dispatched.length > 0) {
              appendTaskLog(id, "system", `Graph-runner: auto-dispatched node-type phases: ${dispatched.join(", ")}`);
            }
            if (taskDone) {
              // All terminal phases completed via auto-dispatch — no agent needed.
              appendTaskLog(id, "system", "Graph-runner: all terminal phases auto-dispatched — skipping agent spawn");
              db.prepare("UPDATE tasks SET status = 'review', updated_at = ? WHERE id = ?").run(nowMs(), id);
              const updatedTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
              broadcast("task_update", updatedTask);
              return res.json({ ok: true, autoCompleted: true });
            }
            // If there are no remaining pending pipeline phases (e.g. all node-type but
            // taskDone not yet set because terminals are blocked), skip agent spawn —
            // UNLESS a phase is awaiting_approval, which needs a different code path.
            if (dispatched.length > 0) {
              const remainingActive = (db as any)
                .prepare(
                  "SELECT COUNT(*) as cnt FROM subtasks WHERE task_id = ? AND title LIKE '[pipeline:%' AND status IN ('pending', 'awaiting_approval')",
                )
                .get(id) as { cnt: number } | undefined;
              if ((remainingActive?.cnt ?? 0) === 0) {
                appendTaskLog(id, "system", "Graph-runner: no pending pipeline phases remain — skipping agent spawn");
                return res.json({ ok: true, autoCompleted: true });
              }
            }
          } catch (err) {
            const stack = err instanceof Error ? err.stack : String(err);
            appendTaskLog(id, "error", `Graph-runner auto-dispatch failed: ${stack}`);
          }
        }
      }
      let sshGuidance = "";
      if (task.id) {
        try {
          const alloc = (db as any)
            .prepare(
              "SELECT sa.server_id, s.id, s.name, s.ssh_config_json FROM server_allocations sa JOIN servers s ON s.id = sa.server_id WHERE sa.task_id = ? AND sa.status = 'active' AND s.ssh_config_json IS NOT NULL LIMIT 1",
            )
            .get(task.id) as { id: string; name: string; ssh_config_json: string } | undefined;
          if (alloc) {
            try {
              const sshCfg = JSON.parse(alloc.ssh_config_json) as { host?: string; port?: number; user?: string };
              sshGuidance = `\n[SSH Server] ${alloc.name}\nConnect: ssh ${sshCfg.user ?? "user"}@${sshCfg.host ?? ""}${sshCfg.port && sshCfg.port !== 22 ? ` -p ${sshCfg.port}` : ""}\nManage via API: GET/POST /api/ops/servers/${alloc.id}/exec, /api/ops/servers/${alloc.id}/files`;
            } catch {
              // best-effort
            }
          }
        } catch {
          // best-effort: table may not exist in older DBs
        }
      }
      let pipelinePhaseHint = "";

      // ── Graph-runner phase prompt path ──
      // Build phase guidance via graphRunner.buildPhasePrompt() for registered packs.
      if (task.workflow_pack_key && packRegistry && graphRunner) {
        let registryPackForPhase: import("../../../../packs/pack-loader.ts").LoadedPack | null = null;
        try {
          registryPackForPhase = packRegistry.get(task.workflow_pack_key);
        } catch {
          // pack not in registry
        }
        if (registryPackForPhase) {
          // Guard: if a pipeline phase is awaiting user gate approval, reject the run.
          // This prevents the autonomous scheduler from re-running a task that is
          // intentionally paused at a user_approval gate.
          const awaitingApprovalPhase = (db as any)
            .prepare(
              "SELECT 1 FROM subtasks WHERE task_id = ? AND title LIKE '[pipeline:%' AND status = 'awaiting_approval' LIMIT 1",
            )
            .get(id);
          if (awaitingApprovalPhase) {
            appendTaskLog(id, "system", "Run blocked: a pipeline phase is awaiting user approval");
            return res
              .status(409)
              .json({ error: "phase_awaiting_approval", message: "A pipeline phase is awaiting user approval" });
          }

          // Determine current phase from subtasks and mark it in_progress so
          // run-complete-handler can identify which phase just finished.
          const currentPhaseSubtask = (db as any)
            .prepare(
              "SELECT id, title FROM subtasks WHERE task_id = ? AND title LIKE '[pipeline:%' AND status = 'pending' ORDER BY created_at ASC LIMIT 1",
            )
            .get(id) as { id?: string; title?: string } | undefined;
          if (currentPhaseSubtask?.title) {
            // Mark the pipeline subtask as in_progress
            (db as any).prepare("UPDATE subtasks SET status = 'in_progress' WHERE id = ?").run(currentPhaseSubtask.id);

            const phaseMatch = currentPhaseSubtask.title.match(/^\[pipeline:([^\]]+)\]/);
            if (phaseMatch) {
              // Strip fan-out index from phase ID (e.g. "image_generation:0" → "image_generation")
              const rawGraphPhaseId = phaseMatch[1];
              const currentGraphPhaseId = rawGraphPhaseId.includes(":")
                ? rawGraphPhaseId.split(":")[0]
                : rawGraphPhaseId;
              const phaseContext = graphRunner.buildPhaseContext(registryPackForPhase, currentGraphPhaseId);
              const phaseGuidance = graphRunner.buildPhasePrompt(registryPackForPhase, currentGraphPhaseId, taskLang);
              if (phaseGuidance) {
                pipelinePhaseHint = `\n${phaseContext}\n\n[Current Pipeline Phase] ${currentGraphPhaseId}\n${phaseGuidance}`;
              } else {
                pipelinePhaseHint = `\n${phaseContext}\n\n[Current Pipeline Phase] ${currentGraphPhaseId}`;
              }
            }
          }
        }
      }

      // ── Department Pipeline prompt augmentation ──
      let deptPipelinePromptPrefix = "";
      let deptPipelineContextBlock = "";
      const freshMeta = parseWorkflowMeta(task.workflow_meta_json);
      if (hasPipeline(freshMeta)) {
        const pl = freshMeta.pipeline;
        const currentDept = getCurrentPipelineDept(pl);
        if (currentDept) {
          deptPipelinePromptPrefix = getPipelineStepPromptPrefix(currentDept, taskLang);
          deptPipelineContextBlock = buildPipelineContextBlock(pl, taskLang);
          if (deptPipelinePromptPrefix) {
            appendTaskLog(
              id,
              "system",
              `Pipeline prompt prefix applied for department '${currentDept}' (step ${pl.current_step + 1}/${pl.steps.length})`,
            );
          }
        }
      }

      const mcpToolsBlock = buildMcpToolsPromptBlock(mcpManager);

      const prompt = buildTaskExecutionPrompt(
        [
          (
            buildAvailableSkillsPromptBlock ||
            ((providerName: string) => `[Available Skills][provider=${providerName || "unknown"}][unavailable]`)
          )(provider),
          `[Task Session] id=${executionSession.sessionId} owner=${executionSession.agentId} provider=${executionSession.provider}`,
          "This session is task-scoped. Keep continuity for this task only and do not cross-contaminate context from other projects.",
          projectContextBlock || projectStructureBlock,
          docsContext.contextBlock ? `\n[Obsidian Docs Context]\n${docsContext.contextBlock}` : "",
          recentChanges ? `[Recent Changes]\n${recentChanges}` : "",
          deptPipelinePromptPrefix ? `[Department Pipeline Instruction]\n${deptPipelinePromptPrefix}` : "",
          `[Task] ${task.title}`,
          task.description ? `\n${task.description}` : "",
          deptPipelineContextBlock,
          buildRelatedTaskContextBlock(db as any, task, logsDir),
          sshGuidance,
          mcpToolsBlock,
          pipelinePhaseHint,
          continuationCtx,
          conversationCtx,
          `\n---`,
          `Agent: ${agent.name} (${roleLabel}, ${agent.department_name || "Unassigned"})`,
          agent.personality ? `Personality: ${agent.personality}` : "",
          deptConstraint,
          departmentPromptBlock,
          `NOTE: You are working in an isolated Git worktree branch (octooffice/${id.slice(0, 8)}). Commit your changes normally.`,
          interruptPromptBlock,
          subtaskInstruction,
          subModelHint,
          continuationInstruction,
          runInstruction,
        ],
        {
          allowWarningFix: hasExplicitWarningFixRequest(task.title, task.description),
        },
      );

      if (pendingInterruptPrompts.length > 0) {
        consumeInterruptPrompts(
          db as any,
          pendingInterruptPrompts.map((row) => row.id),
          nowMs(),
        );
        appendTaskLog(
          id,
          "system",
          `INJECT consumed (${pendingInterruptPrompts.length}) for session ${executionSession.sessionId}`,
        );
      }

      appendTaskLog(id, "system", `RUN start (agent=${agent.name}, provider=${provider})`);

      if (provider === "api") {
        const controller = new AbortController();
        const fakePid = getNextHttpAgentPid();

        const t = nowMs();
        db.prepare(
          "UPDATE tasks SET status = 'in_progress', assigned_agent_id = ?, started_at = ?, updated_at = ? WHERE id = ?",
        ).run(agentId, t, t, id);
        db.prepare("UPDATE agents SET status = 'working', current_task_id = ? WHERE id = ?").run(id, agentId);

        const updatedTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
        const updatedAgent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId);
        broadcast("task_update", updatedTask);
        broadcast("agent_status", updatedAgent);
        notifyTaskStatus(id, task.title, "in_progress", taskLang);

        const assigneeName = getAgentDisplayName(agent as unknown as AgentRow, taskLang);
        const worktreeNote = pickL(
          l(
            [` (격리 브랜치: octooffice/${id.slice(0, 8)})`],
            [` (isolated branch: octooffice/${id.slice(0, 8)})`],
            [` (分離ブランチ: octooffice/${id.slice(0, 8)})`],
            [`（隔离分支: octooffice/${id.slice(0, 8)}）`],
          ),
          taskLang,
        );
        notifyCeo(
          pickL(
            l(
              [`${assigneeName}가 '${task.title}' 작업을 시작했습니다.${worktreeNote}`],
              [`${assigneeName} started work on '${task.title}'.${worktreeNote}`],
              [`${assigneeName}が '${task.title}' の作業を開始しました。${worktreeNote}`],
              [`${assigneeName} 已开始处理 '${task.title}'。${worktreeNote}`],
            ),
            taskLang,
          ),
          id,
        );

        const taskRow = db.prepare("SELECT department_id FROM tasks WHERE id = ?").get(id) as
          | { department_id: string | null }
          | undefined;
        startProgressTimer(id, task.title, taskRow?.department_id ?? null);

        launchApiProviderAgent(
          id,
          agent.api_provider_id ?? null,
          agent.api_model ?? null,
          prompt,
          agentCwd,
          logPath,
          controller,
          fakePid,
        );
        return res.json({ ok: true, pid: fakePid, logPath, cwd: agentCwd, worktree: true });
      }

      if (provider === "copilot" || provider === "antigravity") {
        const controller = new AbortController();
        const fakePid = getNextHttpAgentPid();

        const t = nowMs();
        db.prepare(
          "UPDATE tasks SET status = 'in_progress', assigned_agent_id = ?, started_at = ?, updated_at = ? WHERE id = ?",
        ).run(agentId, t, t, id);
        db.prepare("UPDATE agents SET status = 'working', current_task_id = ? WHERE id = ?").run(id, agentId);

        const updatedTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
        const updatedAgent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId);
        broadcast("task_update", updatedTask);
        broadcast("agent_status", updatedAgent);
        notifyTaskStatus(id, task.title, "in_progress", taskLang);

        const assigneeName = getAgentDisplayName(agent as unknown as AgentRow, taskLang);
        const worktreeNote = pickL(
          l(
            [` (격리 브랜치: octooffice/${id.slice(0, 8)})`],
            [` (isolated branch: octooffice/${id.slice(0, 8)})`],
            [` (分離ブランチ: octooffice/${id.slice(0, 8)})`],
            [`（隔离分支: octooffice/${id.slice(0, 8)}）`],
          ),
          taskLang,
        );
        notifyCeo(
          pickL(
            l(
              [`${assigneeName}가 '${task.title}' 작업을 시작했습니다.${worktreeNote}`],
              [`${assigneeName} started work on '${task.title}'.${worktreeNote}`],
              [`${assigneeName}が '${task.title}' の作業を開始しました。${worktreeNote}`],
              [`${assigneeName} 已开始处理 '${task.title}'。${worktreeNote}`],
            ),
            taskLang,
          ),
          id,
        );

        const taskRow = db.prepare("SELECT department_id FROM tasks WHERE id = ?").get(id) as
          | { department_id: string | null }
          | undefined;
        startProgressTimer(id, task.title, taskRow?.department_id ?? null);

        launchHttpAgent(id, provider, prompt, agentCwd, logPath, controller, fakePid, agent.oauth_account_id ?? null);
        return res.json({ ok: true, pid: fakePid, logPath, cwd: agentCwd, worktree: true });
      }

      const mainProfile = provider === "openclaw" ? agent.cli_profile || undefined : undefined;
      const child = spawnCliAgent(id, provider, prompt, agentCwd, logPath, mainModel, mainReasoningLevel, mainProfile);

      child.on("close", (code: number | null) => {
        handleTaskRunComplete(id, code ?? 1);
      });

      const t = nowMs();
      db.prepare(
        "UPDATE tasks SET status = 'in_progress', assigned_agent_id = ?, started_at = ?, updated_at = ? WHERE id = ?",
      ).run(agentId, t, t, id);
      db.prepare("UPDATE agents SET status = 'working', current_task_id = ? WHERE id = ?").run(id, agentId);

      const updatedTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
      const updatedAgent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId);
      broadcast("task_update", updatedTask);
      broadcast("agent_status", updatedAgent);
      notifyTaskStatus(id, task.title, "in_progress", taskLang);

      const assigneeName = getAgentDisplayName(agent as unknown as AgentRow, taskLang);
      const worktreeNote = pickL(
        l(
          [` (격리 브랜치: octooffice/${id.slice(0, 8)})`],
          [` (isolated branch: octooffice/${id.slice(0, 8)})`],
          [` (分離ブランチ: octooffice/${id.slice(0, 8)})`],
          [`（隔离分支: octooffice/${id.slice(0, 8)}）`],
        ),
        taskLang,
      );
      notifyCeo(
        pickL(
          l(
            [`${assigneeName}가 '${task.title}' 작업을 시작했습니다.${worktreeNote}`],
            [`${assigneeName} started work on '${task.title}'.${worktreeNote}`],
            [`${assigneeName}が '${task.title}' の作業を開始しました。${worktreeNote}`],
            [`${assigneeName} 已开始处理 '${task.title}'。${worktreeNote}`],
          ),
          taskLang,
        ),
        id,
      );

      const taskRow = db.prepare("SELECT department_id FROM tasks WHERE id = ?").get(id) as
        | { department_id: string | null }
        | undefined;
      startProgressTimer(id, task.title, taskRow?.department_id ?? null);

      res.json({ ok: true, pid: child.pid ?? null, logPath, cwd: agentCwd, worktree: true });
    } catch (err) {
      if (!res.headersSent) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ ok: false, error: "INTERNAL_ERROR", message });
      }
    } finally {
      taskLaunchLocks.delete(id);
    }
  });
}
