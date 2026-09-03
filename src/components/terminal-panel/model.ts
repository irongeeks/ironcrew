import type { Agent, Task } from "../../types";
import type { LangText } from "../../i18n";

export interface TerminalPanelProps {
  taskId: string;
  task: Task | undefined;
  agent: Agent | undefined;
  agents: Agent[];
  initialTab?: "terminal" | "minutes";
  onClose: () => void;
}

export const STATUS_BADGES: Record<string, { label: LangText; color: string }> = {
  in_progress: {
    label: { ko: "진행중", en: "Running", ja: "実行中", zh: "Running", de: "Läuft" },
    color: "bg-amber-500/20 text-amber-400 border-amber-500/40",
  },
  review: {
    label: { ko: "검토", en: "Review", ja: "レビュー", zh: "Review", de: "Überprüfung" },
    color: "bg-purple-500/20 text-purple-400 border-purple-500/40",
  },
  done: {
    label: { ko: "완료", en: "Done", ja: "完了", zh: "Done", de: "Erledigt" },
    color: "bg-green-500/20 text-green-400 border-green-500/40",
  },
  inbox: {
    label: { ko: "수신함", en: "Inbox", ja: "受信箱", zh: "Inbox", de: "Posteingang" },
    color: "bg-slate-500/20 text-slate-400 border-slate-500/40",
  },
  planned: {
    label: { ko: "예정", en: "Planned", ja: "予定", zh: "Planned", de: "Geplant" },
    color: "bg-blue-500/20 text-blue-400 border-blue-500/40",
  },
  cancelled: {
    label: { ko: "취소", en: "Cancelled", ja: "キャンセル", zh: "Cancelled", de: "Abgebrochen" },
    color: "bg-red-500/20 text-red-400 border-red-500/40",
  },
};

export interface TaskLogEntry {
  id: number;
  kind: string;
  message: string;
  created_at: number;
}

export const TERMINAL_TAIL_LINES = 2000;
export const TERMINAL_TASK_LOG_LIMIT = 300;
export const INTERVENTION_PROMPT_MAX_LENGTH = 4000;
