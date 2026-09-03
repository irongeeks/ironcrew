import type { DatabaseSync } from "node:sqlite";

type PromptSkillProvider = "claude" | "codex" | "gemini" | "opencode" | "copilot" | "antigravity" | "api";
type PromptSkillRow = {
  repo: string;
  skill_id: string;
  skill_label: string;
  learned_at: number;
};

const SKILL_PROMPT_FETCH_LIMIT = 8;
const SKILL_PROMPT_INLINE_LIMIT = 4;

function isPromptSkillProvider(provider: string): provider is PromptSkillProvider {
  return (
    provider === "claude" ||
    provider === "codex" ||
    provider === "gemini" ||
    provider === "opencode" ||
    provider === "copilot" ||
    provider === "antigravity" ||
    provider === "api"
  );
}

function getPromptSkillProviderDisplayName(provider: string): string {
  if (provider === "claude") return "Claude Code";
  if (provider === "codex") return "Codex";
  if (provider === "gemini") return "Gemini";
  if (provider === "opencode") return "OpenCode";
  if (provider === "copilot") return "GitHub Copilot";
  if (provider === "antigravity") return "Antigravity";
  if (provider === "api") return "API Provider";
  return provider || "unknown";
}

function clipPromptSkillLabel(label: string, maxLength = 56): string {
  const normalized = label.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function formatPromptSkillTag(repo: string, skillId: string, skillLabel: string): string {
  const fallback = skillId ? `${repo}#${skillId}` : repo;
  const source = skillLabel || fallback;
  const clipped = clipPromptSkillLabel(source);
  return clipped ? `[${clipped}]` : "";
}

function dedupePromptSkills(rows: PromptSkillRow[]): PromptSkillRow[] {
  const out: PromptSkillRow[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const repo = String(row.repo || "")
      .trim()
      .toLowerCase();
    const skillId = String(row.skill_id || "")
      .trim()
      .toLowerCase();
    if (!repo) continue;
    const key = `${repo}::${skillId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function formatPromptSkillTagLine(rows: PromptSkillRow[]): string {
  const tags = dedupePromptSkills(rows)
    .map((row) => formatPromptSkillTag(row.repo, row.skill_id, row.skill_label))
    .filter(Boolean);
  if (tags.length === 0) return "[none]";
  const inlineCount = Math.min(tags.length, SKILL_PROMPT_INLINE_LIMIT);
  const inline = tags.slice(0, inlineCount).join("");
  const overflow = tags.length - inlineCount;
  return overflow > 0 ? `${inline}[+${overflow} more]` : inline;
}

function queryPromptSkillsByProvider(db: DatabaseSync, provider: PromptSkillProvider, limit: number): PromptSkillRow[] {
  return db
    .prepare(
      `
    SELECT
      repo,
      skill_id,
      skill_label,
      MAX(COALESCE(run_completed_at, updated_at, created_at)) AS learned_at
    FROM skill_learning_history
    WHERE status = 'succeeded' AND provider = ?
    GROUP BY repo, skill_id, skill_label
    ORDER BY learned_at DESC
    LIMIT ?
  `,
    )
    .all(provider, limit) as PromptSkillRow[];
}

function queryPromptSkillsGlobal(db: DatabaseSync, limit: number): PromptSkillRow[] {
  return db
    .prepare(
      `
    SELECT
      repo,
      skill_id,
      skill_label,
      MAX(COALESCE(run_completed_at, updated_at, created_at)) AS learned_at
    FROM skill_learning_history
    WHERE status = 'succeeded'
    GROUP BY repo, skill_id, skill_label
    ORDER BY learned_at DESC
    LIMIT ?
  `,
    )
    .all(limit) as PromptSkillRow[];
}

function buildSkillRuntimePolicyLines(providerScoped: boolean): string[] {
  return [
    providerScoped
      ? "[Skills Rule] Prioritize provider-matched learned skills from Skills Library DB first."
      : "[Skills Rule] Prioritize learned skills from Skills Library DB first.",
    "[Skills Rule] Also use globally installed skills available in this user's environment (setup may differ by machine).",
    "[MCP Rule] Use available MCP servers/tools for context discovery and verification when supported by this runtime.",
    "[Skills Rule] If overlaps exist, prefer learned skills first, then global/runtime skills.",
  ];
}

export function createPromptSkillsHelper(db: DatabaseSync): {
  buildAvailableSkillsPromptBlock: (provider: string) => string;
} {
  function buildAvailableSkillsPromptBlock(provider: string): string {
    const providerDisplay = getPromptSkillProviderDisplayName(provider);
    try {
      const providerKey = isPromptSkillProvider(provider) ? provider : null;
      const providerLearnedSkills = providerKey
        ? queryPromptSkillsByProvider(db, providerKey, SKILL_PROMPT_FETCH_LIMIT)
        : [];
      const globalLearnedSkills = queryPromptSkillsGlobal(db, SKILL_PROMPT_FETCH_LIMIT);

      if (providerLearnedSkills.length > 0) {
        const providerTags = formatPromptSkillTagLine(providerLearnedSkills);
        return [
          `[Available Skills][provider=${providerDisplay}][source=skills-library-db][scope=provider]${providerTags}`,
          `[Available Skills][provider=${providerDisplay}][source=skills-library-db][scope=global]${formatPromptSkillTagLine(globalLearnedSkills)}`,
          ...buildSkillRuntimePolicyLines(true),
        ].join("\n");
      }

      if (globalLearnedSkills.length > 0) {
        return [
          `[Available Skills][provider=${providerDisplay}][source=skills-library-db][scope=global]${formatPromptSkillTagLine(globalLearnedSkills)}`,
          ...buildSkillRuntimePolicyLines(false),
        ].join("\n");
      }

      return [
        `[Available Skills][provider=${providerDisplay}][source=skills-library-db][scope=global][empty]${formatPromptSkillTagLine([])}`,
        "[Skills Rule] No learned skills recorded in DB yet.",
        ...buildSkillRuntimePolicyLines(false),
      ].join("\n");
    } catch {
      return [
        `[Available Skills][provider=${providerDisplay}][source=skills-library-db][fallback=unavailable]${formatPromptSkillTagLine([])}`,
        "[Skills Rule] Skills history lookup failed.",
        ...buildSkillRuntimePolicyLines(false),
      ].join("\n");
    }
  }

  return { buildAvailableSkillsPromptBlock };
}
