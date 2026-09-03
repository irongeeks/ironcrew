import type { SkillHistoryProvider, SkillLearningHistoryEntry } from "../../api";
import type { Agent, AgentRole } from "../../types";

export const PROVIDER_ORDER: SkillHistoryProvider[] = [
  "claude",
  "codex",
  "gemini",
  "opencode",
  "copilot",
  "antigravity",
  "api",
];

export const HISTORY_PREVIEW_COUNT = 3;

const ROLE_ORDER: Record<AgentRole, number> = {
  team_leader: 0,
  senior: 1,
  junior: 2,
  intern: 3,
};

export function providerLabel(provider: SkillHistoryProvider): string {
  if (provider === "claude") return "Claude Code";
  if (provider === "codex") return "Codex";
  if (provider === "gemini") return "Gemini";
  if (provider === "opencode") return "OpenCode";
  if (provider === "copilot") return "GitHub Copilot";
  if (provider === "antigravity") return "Antigravity";
  return "API Provider";
}

export function statusLabel(status: SkillLearningHistoryEntry["status"]): string {
  if (status === "queued") return "Queued";
  if (status === "running") return "Running";
  if (status === "succeeded") return "Succeeded";
  return "Failed";
}

export function statusClass(status: SkillLearningHistoryEntry["status"]): string {
  if (status === "succeeded") return "border-emerald-400/40 bg-emerald-500/10 text-emerald-300";
  if (status === "running") return "border-amber-400/40 bg-amber-500/10 text-amber-200";
  if (status === "queued") return "border-slate-500/40 bg-slate-600/10 text-slate-300";
  return "border-rose-400/40 bg-rose-500/10 text-rose-300";
}

export function relativeTime(timestamp: number | null | undefined): string {
  if (!timestamp || !Number.isFinite(timestamp)) return "-";
  const diffSec = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  const diffMonth = Math.floor(diffDay / 30);
  if (diffMonth < 12) return `${diffMonth}mo ago`;
  const diffYear = Math.floor(diffMonth / 12);
  return `${diffYear}y ago`;
}

export function normalizeSkillLabel(row: { repo: string; skill_id: string; skill_label: string }): string {
  if (row.skill_label && row.skill_label.trim()) return row.skill_label;
  if (row.skill_id && row.skill_id.trim()) return `${row.repo}#${row.skill_id}`;
  return row.repo;
}

export function learningRowKey(row: { provider: SkillHistoryProvider; repo: string; skill_id: string }): string {
  return `${row.provider}:${row.repo}:${row.skill_id}`;
}

export function pickRepresentativeForProvider(agents: Agent[], provider: SkillHistoryProvider): Agent | null {
  const candidates = agents.filter((agent) => agent.cli_provider === provider);
  if (candidates.length === 0) return null;
  const sorted = [...candidates].sort((a, b) => {
    const roleGap = ROLE_ORDER[a.role] - ROLE_ORDER[b.role];
    if (roleGap !== 0) return roleGap;
    return a.id.localeCompare(b.id);
  });
  return sorted[0];
}
