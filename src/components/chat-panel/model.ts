import type { LangText } from "../../i18n";

export interface StreamingMessage {
  message_id: string;
  agent_id: string;
  agent_name: string;
  agent_avatar: string;
  content: string;
}

export type ChatMode = "chat" | "task" | "announcement" | "report";

export type ProjectMetaPayload = {
  project_id?: string;
  project_path?: string;
  project_context?: string;
};

export type PendingSendAction =
  | { kind: "directive"; content: string }
  | { kind: "announcement"; content: string }
  | { kind: "task"; content: string; receiverId: string }
  | { kind: "report"; content: string; receiverId: string }
  | { kind: "chat"; content: string; receiverId: string }
  | { kind: "broadcast"; content: string };

export const STATUS_COLORS: Record<string, string> = {
  idle: "bg-zinc-400",
  working: "bg-emerald-400",
  break: "bg-amber-400",
  offline: "bg-zinc-500",
};

export const STATUS_LABELS: Record<string, LangText> = {
  idle: { en: "Idle", de: "Inaktiv" },
  working: { en: "Working", de: "Aktiv" },
  break: { en: "Break", de: "Pause" },
  offline: { en: "Offline", de: "Offline" },
};

export const ROLE_LABELS: Record<string, LangText> = {
  team_leader: { en: "Team Leader", de: "Teamleiter" },
  senior: { en: "Senior", de: "Senior" },
  junior: { en: "Junior", de: "Junior" },
  intern: { en: "Intern", de: "Praktikant" },
};

export function isPromiseLike(value: unknown): value is Promise<void> {
  return !!value && typeof (value as { then?: unknown }).then === "function";
}
