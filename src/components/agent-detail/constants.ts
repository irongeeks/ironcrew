import type { OAuthAccountInfo } from "../../api";
import type { LangText, UiLanguage } from "../../i18n";

export type Locale = UiLanguage;
export type TFunction = (messages: LangText) => string;

export function roleLabel(role: string, t: TFunction) {
  switch (role) {
    case "team_leader":
      return t({ en: "Team Leader", de: "Teamleiter" });
    case "senior":
      return t({ en: "Senior", de: "Senior" });
    case "junior":
      return t({ en: "Junior", de: "Junior" });
    case "intern":
      return t({ en: "Intern", de: "Praktikant" });
    default:
      return role;
  }
}

function hashSubAgentId(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export function getSubAgentSpriteNum(subAgentId: string): number {
  return (hashSubAgentId(`${subAgentId}:clone`) % 13) + 1;
}

export const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  idle: { label: "idle", color: "text-green-400", bg: "bg-green-500/20" },
  working: { label: "working", color: "text-blue-400", bg: "bg-blue-500/20" },
  break: { label: "break", color: "text-yellow-400", bg: "bg-yellow-500/20" },
  offline: {
    label: "offline",
    color: "text-slate-400",
    bg: "bg-slate-500/20",
  },
};

export const CLI_LABELS: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex CLI",
  gemini: "Gemini CLI",
  opencode: "OpenCode",
  openclaw: "OpenClaw",
  copilot: "GitHub Copilot",
  antigravity: "Antigravity",
  api: "API Provider",
};

export const SUBTASK_STATUS_ICON: Record<string, string> = {
  pending: "\u23F3",
  in_progress: "\uD83D\uDD28",
  done: "\u2705",
  blocked: "\uD83D\uDEAB",
  awaiting_approval: "\u23F8\uFE0F",
  skipped: "\u23ED\uFE0F",
};

export function oauthAccountLabel(account: OAuthAccountInfo): string {
  return account.label || account.email || account.id.slice(0, 8);
}

export function statusLabel(status: string, t: TFunction) {
  switch (status) {
    case "idle":
      return t({ en: "Idle", de: "Inaktiv" });
    case "working":
      return t({ en: "Working", de: "Aktiv" });
    case "break":
      return t({ en: "Break", de: "Pause" });
    case "offline":
      return t({ en: "Offline", de: "Offline" });
    default:
      return status;
  }
}

export function taskStatusLabel(status: string, t: TFunction) {
  switch (status) {
    case "inbox":
      return t({ en: "Inbox", de: "Posteingang" });
    case "planned":
      return t({ en: "Planned", de: "Geplant" });
    case "in_progress":
      return t({ en: "In Progress", de: "In Arbeit" });
    case "review":
      return t({ en: "Review", de: "Überprüfung" });
    case "done":
      return t({ en: "Done", de: "Erledigt" });
    case "pending":
      return t({ en: "Pending", de: "Ausstehend" });
    case "cancelled":
      return t({ en: "Cancelled", de: "Abgebrochen" });
    default:
      return status;
  }
}

export function taskTypeLabel(type: string, t: TFunction) {
  switch (type) {
    case "general":
      return t({ en: "General", de: "Allgemein" });
    case "development":
      return t({ en: "Development", de: "Entwicklung" });
    case "design":
      return t({ en: "Design", de: "Design" });
    case "analysis":
      return t({ en: "Analysis", de: "Analyse" });
    case "presentation":
      return t({ en: "Presentation", de: "Präsentation" });
    case "documentation":
      return t({ en: "Documentation", de: "Dokumentation" });
    default:
      return type;
  }
}
