import type { RuntimeContext } from "../../../types/runtime-context.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCrossDeptSubtaskTools } from "./coordination/cross-dept-subtasks.ts";
import { createCrossDeptCooperationTools } from "./coordination/cross-dept-cooperation.ts";
import { createReportRoutingTools } from "./coordination/report-routing.ts";

type DelegationOptions = {
  skipPlannedMeeting?: boolean;
  skipPlanSubtasks?: boolean;
  projectId?: string | null;
  projectPath?: string | null;
  projectContext?: string | null;
};

export type CollabCoordinationDeps = Pick<
  RuntimeContext,
  | "db"
  | "appendTaskLog"
  | "broadcast"
  | "buildTaskExecutionPrompt"
  | "buildAvailableSkillsPromptBlock"
  | "crossDeptNextCallbacks"
  | "delegatedTaskToSubtask"
  | "ensureTaskExecutionSession"
  | "findBestSubordinate"
  | "findTeamLeader"
  | "getAgentDisplayName"
  | "getDeptName"
  | "getDeptRoleConstraint"
  | "getProviderModelConfig"
  | "getRecentConversationContext"
  | "handleSubtaskDelegationComplete"
  | "handleTaskRunComplete"
  | "hasExplicitWarningFixRequest"
  | "isTaskWorkflowInterrupted"
  | "l"
  | "logsDir"
  | "maybeNotifyAllSubtasksComplete"
  | "notifyCeo"
  | "nowMs"
  | "pickL"
  | "randomDelay"
  | "recordTaskCreationAudit"
  | "resolveLang"
  | "sendAgentMessage"
  | "spawnCliAgent"
  | "startProgressTimer"
  | "startTaskExecutionForAgent"
>;

export function initializeCollabCoordination(deps: CollabCoordinationDeps): any {
  const {
    db,
    appendTaskLog,
    broadcast,
    buildTaskExecutionPrompt,
    crossDeptNextCallbacks,
    delegatedTaskToSubtask,
    ensureTaskExecutionSession,
    findBestSubordinate,
    findTeamLeader,
    getAgentDisplayName,
    getDeptName,
    getDeptRoleConstraint,
    getProviderModelConfig,
    getRecentConversationContext,
    handleSubtaskDelegationComplete,
    handleTaskRunComplete,
    hasExplicitWarningFixRequest,
    isTaskWorkflowInterrupted,
    l,
    logsDir,
    notifyCeo,
    nowMs,
    pickL,
    randomDelay,
    recordTaskCreationAudit,
    resolveLang,
    sendAgentMessage,
    spawnCliAgent,
    startProgressTimer,
    startTaskExecutionForAgent,
  } = deps;
  const buildAvailableSkillsPromptBlock =
    deps.buildAvailableSkillsPromptBlock ||
    ((provider: string) => `[Available Skills][provider=${provider || "unknown"}][unavailable]`);

  const { linkCrossDeptTaskToParentSubtask, reconcileCrossDeptSubtasks } = createCrossDeptSubtaskTools({
    db,
    nowMs,
    broadcast,
    delegatedTaskToSubtask,
  });

  function normalizeTextField(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  /**
   * Detect project path from CEO message.
   * Recognizes:
   * 1. Absolute paths: /home/user/Projects/foo, ~/Projects/bar
   * 2. Project names: "ironcrew 프로젝트", "claw-kanban에서"
   * 3. Known project directories under ~/Projects
   */
  function detectProjectPath(message: string): string | null {
    const homeDir = os.homedir();
    const projectsDir = path.join(homeDir, "Projects");
    const projectsDirLower = path.join(homeDir, "projects");
    const isDirectorySafe = (targetPath: string): boolean => {
      try {
        return fs.statSync(targetPath).isDirectory();
      } catch {
        return false;
      }
    };
    const readProjectNamesSafe = (projectDir: string): string[] => {
      try {
        return fs
          .readdirSync(projectDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
          .map((entry) => entry.name);
      } catch {
        return [];
      }
    };

    // 1. Explicit absolute path in message
    const absMatch = message.match(/(?:^|\s)(\/[\w./-]+)/);
    if (absMatch) {
      const p = absMatch[1];
      // Check if it's a real directory
      if (isDirectorySafe(p)) return p;
      // Check parent directory
      const parent = path.dirname(p);
      if (isDirectorySafe(parent)) return parent;
    }

    // 2. ~ path
    const tildeMatch = message.match(/~\/([\w./-]+)/);
    if (tildeMatch) {
      const expanded = path.join(homeDir, tildeMatch[1]);
      if (isDirectorySafe(expanded)) return expanded;
    }

    // 3. Scan known project directories and match by name
    const knownProjects = [projectsDir, projectsDirLower].flatMap((projectDir) => readProjectNamesSafe(projectDir));

    // Match project names in the message (case-insensitive)
    const msgLower = message.toLowerCase();
    for (const proj of knownProjects) {
      if (msgLower.includes(proj.toLowerCase())) {
        // Return the actual path
        const fullPath = path.join(projectsDir, proj);
        if (isDirectorySafe(fullPath)) return fullPath;
        const fullPathLower = path.join(projectsDirLower, proj);
        if (isDirectorySafe(fullPathLower)) return fullPathLower;
      }
    }

    return null;
  }

  /**
   * Resolve project path (canonical-first):
   * 1) task.project_id -> projects.project_path
   * 2) task.project_path
   * 3) detect from description/title
   * 4) process.cwd()
   */
  function resolveProjectPath(task: {
    project_id?: string | null;
    project_path?: string | null;
    description?: string | null;
    title?: string;
  }): string | null {
    const projectId = String(task.project_id ?? "").trim();
    if (projectId) {
      const row = db
        .prepare(
          `
      SELECT project_path
      FROM projects
      WHERE id = ?
      LIMIT 1
    `,
        )
        .get(projectId) as { project_path: string | null } | undefined;
      const canonical = String(row?.project_path ?? "").trim();
      if (canonical) {
        const detectedCanonical = detectProjectPath(canonical);
        return detectedCanonical || canonical;
      }
    }

    const taskProjectPath = String(task.project_path ?? "").trim();
    if (taskProjectPath) {
      const detectedTaskPath = detectProjectPath(taskProjectPath);
      return detectedTaskPath || taskProjectPath;
    }

    const detected = detectProjectPath(task.description || "") || detectProjectPath(task.title || "");
    return detected || null;
  }

  function getLatestKnownProjectPath(): string | null {
    const row = db
      .prepare(
        `
    SELECT project_path
    FROM tasks
    WHERE project_path IS NOT NULL AND TRIM(project_path) != ''
    ORDER BY updated_at DESC
    LIMIT 1
  `,
      )
      .get() as { project_path: string | null } | undefined;
    const candidate = normalizeTextField(row?.project_path ?? null);
    if (!candidate) return null;
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      // Ignore stale paths from historical task rows.
    }
    return null;
  }

  function getDefaultProjectRoot(): string {
    const homeDir = os.homedir();
    const candidates = [path.join(homeDir, "Projects"), path.join(homeDir, "projects"), process.cwd()];
    for (const candidate of candidates) {
      try {
        if (fs.statSync(candidate).isDirectory()) return candidate;
      } catch {
        // Ignore inaccessible or non-existent directories.
      }
    }
    return process.cwd();
  }

  function resolveDirectiveProjectPath(
    ceoMessage: string,
    options: DelegationOptions = {},
  ): { projectPath: string | null; source: string } {
    const explicitProjectId = normalizeTextField((options as { projectId?: unknown }).projectId);
    if (explicitProjectId) {
      const projectById = db
        .prepare(
          `
      SELECT project_path
      FROM projects
      WHERE id = ?
      LIMIT 1
    `,
        )
        .get(explicitProjectId) as { project_path: string | null } | undefined;
      const byIdPath = normalizeTextField(projectById?.project_path);
      if (byIdPath) {
        const detectedByIdPath = detectProjectPath(byIdPath) || byIdPath;
        return { projectPath: detectedByIdPath, source: "project_id" };
      }
    }

    const explicitProjectPath = normalizeTextField(options.projectPath);
    if (explicitProjectPath) {
      const detected = detectProjectPath(explicitProjectPath);
      if (detected) return { projectPath: detected, source: "project_path" };
    }

    const contextHint = normalizeTextField(options.projectContext);
    if (contextHint) {
      const detectedFromContext = detectProjectPath(contextHint);
      if (detectedFromContext) return { projectPath: detectedFromContext, source: "project_context" };

      const newProjectHint =
        /신규\s*프로젝트|새\s*프로젝트|new project|greenfield|from scratch|新規.*プロジェクト|新项目/i.test(
          contextHint,
        );
      if (newProjectHint) {
        return { projectPath: getDefaultProjectRoot(), source: "new_project_default" };
      }
    }

    const detectedFromMessage = detectProjectPath(ceoMessage);
    if (detectedFromMessage) return { projectPath: detectedFromMessage, source: "message" };

    return { projectPath: null, source: "none" };
  }

  const { recoverCrossDeptQueueAfterMissingCallback, startCrossDeptCooperation } = createCrossDeptCooperationTools({
    db,
    nowMs,
    appendTaskLog,
    broadcast,
    recordTaskCreationAudit,
    delegatedTaskToSubtask,
    crossDeptNextCallbacks,
    findTeamLeader,
    findBestSubordinate,
    resolveLang,
    getDeptName,
    getAgentDisplayName,
    sendAgentMessage,
    notifyCeo,
    l,
    pickL,
    startTaskExecutionForAgent,
    linkCrossDeptTaskToParentSubtask,
    detectProjectPath,
    resolveProjectPath,
    logsDir,
    getDeptRoleConstraint,
    getRecentConversationContext,
    buildAvailableSkillsPromptBlock,
    buildTaskExecutionPrompt,
    hasExplicitWarningFixRequest,
    ensureTaskExecutionSession,
    getProviderModelConfig,
    spawnCliAgent,
    handleSubtaskDelegationComplete,
    handleTaskRunComplete,
    startProgressTimer,
  });

  const { stripReportRequestPrefix, detectReportOutputFormat, pickPlanningReportAssignee, handleReportRequest } =
    createReportRoutingTools({
      db,
      nowMs,
      randomDelay,
      resolveLang,
      detectProjectPath,
      normalizeTextField,
      recordTaskCreationAudit,
      appendTaskLog,
      getAgentDisplayName,
      sendAgentMessage,
      notifyCeo,
      l,
      pickL,
      broadcast,
      isTaskWorkflowInterrupted,
      startTaskExecutionForAgent,
    });

  return {
    reconcileCrossDeptSubtasks,
    recoverCrossDeptQueueAfterMissingCallback,
    startCrossDeptCooperation,
    detectProjectPath,
    resolveProjectPath,
    getLatestKnownProjectPath,
    getDefaultProjectRoot,
    resolveDirectiveProjectPath,
    stripReportRequestPrefix,
    detectReportOutputFormat,
    pickPlanningReportAssignee,
    handleReportRequest,
  };
}
