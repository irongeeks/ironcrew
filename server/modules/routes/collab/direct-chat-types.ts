import type { RuntimeContext } from "../../../types/runtime-context.ts";
import type { Lang } from "../../../types/lang.ts";
import type { DelegationOptions } from "./project-resolution.ts";

export interface AgentRow {
  id: string;
  name: string;
  name_ko: string;
  role: string;
  acts_as_planning_leader?: number | null;
  personality: string | null;
  status: string;
  department_id: string | null;
  current_task_id: string | null;
  avatar_emoji: string;
  cli_provider: string | null;
  oauth_account_id: string | null;
  api_provider_id: string | null;
  api_model: string | null;
  cli_model: string | null;
  cli_reasoning_level: string | null;
  cli_profile: string | null;
}

export type L10n = Record<Lang, string[]>;

export type DirectReplyPayload = {
  text?: string;
};

export type DirectReplyBuild = {
  prompt: string;
  lang: Lang;
};

export type DirectChatDeps = {
  db: RuntimeContext["db"];
  logsDir: string;
  nowMs: () => number;
  randomDelay: (minMs: number, maxMs: number) => number;
  broadcast: (type: string, payload: unknown) => void;
  appendTaskLog: (taskId: string, kind: string, message: string) => void;
  recordTaskCreationAudit: RuntimeContext["recordTaskCreationAudit"];
  resolveLang: (text?: string, fallback?: Lang) => Lang;
  resolveProjectPath: (taskLike: { project_path?: string | null; description?: string | null }) => string | null;
  detectProjectPath: (text: string) => string | null;
  normalizeTextField: (value: unknown) => string | null;
  resolveProjectFromOptions: (options: DelegationOptions) => {
    id: string | null;
    name: string | null;
    projectPath: string | null;
    coreGoal: string | null;
  };
  buildRoundGoal: (projectCoreGoal: string, message: string) => string;
  getDeptName: (deptId: string) => string;
  l: (ko: string[], en: string[], ja?: string[], zh?: string[]) => L10n;
  pickL: (pool: L10n, lang: Lang) => string;
  sendAgentMessage: (
    agent: AgentRow,
    content: string,
    messageType?: string,
    receiverType?: string,
    receiverId?: string | null,
    taskId?: string | null,
  ) => void;
  registerTaskMessengerRoute: (taskId: string, options?: DelegationOptions) => void;
  chooseSafeReply: (run: { text?: string }, lang: string, context: string, agent?: AgentRow) => string;
  buildCliFailureMessage: (agent: AgentRow, lang: Lang, reason: string) => string;
  buildDirectReplyPrompt: (
    agent: AgentRow,
    ceoMessage: string,
    messageType: string,
  ) => { prompt: string; lang: string };
  runAgentOneShot: (
    agent: AgentRow,
    prompt: string,
    opts?: { projectPath?: string; rawOutput?: true; noTools?: boolean },
  ) => Promise<{ text?: string }>;
  executeApiProviderAgent: RuntimeContext["executeApiProviderAgent"];
  executeCopilotAgent: RuntimeContext["executeCopilotAgent"];
  executeAntigravityAgent: RuntimeContext["executeAntigravityAgent"];
  isTaskWorkflowInterrupted: (taskId: string) => boolean;
  startTaskExecutionForAgent: (
    taskId: string,
    agent: AgentRow,
    deptId: string | null,
    deptName: string,
    options?: {
      onMainTaskDone?: () => void;
      disableCrossDeptAfterMain?: boolean;
    },
  ) => void;
  handleTaskDelegation: (
    teamLeader: AgentRow,
    ceoMessage: string,
    mentionContext: string,
    options?: DelegationOptions,
  ) => void;
};

export type PendingProjectBindingState = "ask_kind" | "ask_existing" | "ask_new_name" | "ask_new_path";

export type ExistingProjectCandidate = {
  id: string;
  name: string | null;
  projectPath: string | null;
  projectContext: string | null;
};

export type PendingProjectBinding = {
  taskMessage: string;
  options: DelegationOptions;
  requestedAt: number;
  state: PendingProjectBindingState;
  newProjectName?: string;
  existingCandidates?: ExistingProjectCandidate[];
};

export type ProjectProgressTarget = {
  projectId: string | null;
  projectName: string | null;
  projectPath: string | null;
  projectContext: string | null;
};

export type ProjectProgressTaskRow = {
  id: string;
  title: string;
  status: string;
  updated_at: number;
  assigned_agent_id: string | null;
  assignee_name: string | null;
  assignee_name_ko: string | null;
};
