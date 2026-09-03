import type { SkillHistoryProvider, SkillLearnProvider } from "./types.ts";

export const SKILL_LEARN_PROVIDER_TO_AGENT: Record<SkillLearnProvider, string> = {
  claude: "claude-code",
  codex: "codex",
  gemini: "gemini-cli",
  opencode: "opencode",
};

export const SKILL_HISTORY_PROVIDER_TO_AGENT: Record<SkillHistoryProvider, string | null> = {
  claude: "claude-code",
  codex: "codex",
  gemini: "gemini-cli",
  opencode: "opencode",
  copilot: "github-copilot",
  antigravity: "antigravity",
  api: null,
  browser: null,
};

export const SKILL_LEARN_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;
export const SKILL_LEARN_MAX_LOG_LINES = 120;
export const SKILL_LEARN_JOB_TTL_MS = 30 * 60 * 1000;
export const SKILL_LEARN_MAX_JOBS = 200;
export const SKILL_LEARN_HISTORY_RETENTION_DAYS = 180;
export const SKILL_LEARN_HISTORY_RETENTION_MS = SKILL_LEARN_HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
export const SKILL_LEARN_HISTORY_MAX_ROWS_PER_PROVIDER = 2_000;
export const SKILL_LEARN_HISTORY_MAX_QUERY_LIMIT = 200;
export const SKILL_UNLEARN_TIMEOUT_MS = 20_000;
export const SKILLS_NPX_CMD = process.platform === "win32" ? "npx.cmd" : "npx";

export function isSkillLearnProvider(value: string): value is SkillLearnProvider {
  return value === "claude" || value === "codex" || value === "gemini" || value === "opencode";
}

export function isSkillHistoryProvider(value: string): value is SkillHistoryProvider {
  return (
    isSkillLearnProvider(value) ||
    value === "copilot" ||
    value === "antigravity" ||
    value === "api" ||
    value === "browser"
  );
}
