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
  idle: { ko: "대기중", en: "Idle", ja: "待機中", zh: "Idle", de: "Inaktiv" },
  working: { ko: "작업중", en: "Working", ja: "作業中", zh: "Working", de: "Aktiv" },
  break: { ko: "휴식", en: "Break", ja: "休憩中", zh: "Break", de: "Pause" },
  offline: { ko: "오프라인", en: "Offline", ja: "オフライン", zh: "Offline", de: "Offline" },
};

export const ROLE_LABELS: Record<string, LangText> = {
  team_leader: { ko: "팀장", en: "Team Leader", ja: "チームリーダー", zh: "Team Leader", de: "Teamleiter" },
  senior: { ko: "시니어", en: "Senior", ja: "シニア", zh: "Senior", de: "Senior" },
  junior: { ko: "주니어", en: "Junior", ja: "ジュニア", zh: "Junior", de: "Junior" },
  intern: { ko: "인턴", en: "Intern", ja: "インターン", zh: "Intern", de: "Praktikant" },
};

export function isPromiseLike(value: unknown): value is Promise<void> {
  return !!value && typeof (value as { then?: unknown }).then === "function";
}
