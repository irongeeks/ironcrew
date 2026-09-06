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
    label: { en: "Running", de: "Läuft" },
    color: "bg-amber-500/20 text-amber-400 border-amber-500/40",
  },
  review: {
    label: { en: "Review", de: "Überprüfung" },
    color: "bg-purple-500/20 text-purple-400 border-purple-500/40",
  },
  done: {
    label: { en: "Done", de: "Erledigt" },
    color: "bg-green-500/20 text-green-400 border-green-500/40",
  },
  inbox: {
    label: { en: "Inbox", de: "Posteingang" },
    color: "bg-slate-500/20 text-slate-400 border-slate-500/40",
  },
  planned: {
    label: { en: "Planned", de: "Geplant" },
    color: "bg-blue-500/20 text-blue-400 border-blue-500/40",
  },
  cancelled: {
    label: { en: "Cancelled", de: "Abgebrochen" },
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
