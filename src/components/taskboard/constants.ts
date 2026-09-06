import type { TaskStatus, TaskType } from "../../types";
import type { LangText, UiLanguage } from "../../i18n";
import { readStoredValue, writeStoredValue } from "../../storage";

export type Locale = UiLanguage;
export type TFunction = (messages: LangText) => string;

const TASK_CREATE_DRAFTS_STORAGE_KEY = "ironcrew.taskCreateDrafts";

export const HIDEABLE_STATUSES = ["done", "pending", "cancelled"] as const;
export type HideableStatus = (typeof HIDEABLE_STATUSES)[number];

export type CreateTaskDraft = {
  id: string;
  title: string;
  description: string;
  departmentId: string;
  taskType: TaskType;
  priority: number;
  assignAgentId: string;
  projectId: string;
  projectQuery: string;
  createNewProjectMode: boolean;
  newProjectPath: string;
  packInputValues?: Record<string, string>;
  skippedPhases?: string[];
  updatedAt: number;
};

export type MissingPathPrompt = {
  normalizedPath: string;
  canCreate: boolean;
  nearestExistingParent: string | null;
};

export type FormFeedback = {
  tone: "error" | "info";
  message: string;
};

export type ManualPathEntry = {
  name: string;
  path: string;
};

export function isHideableStatus(status: TaskStatus): status is HideableStatus {
  return (HIDEABLE_STATUSES as readonly TaskStatus[]).includes(status);
}

export function createDraftId(): string {
  if (typeof globalThis !== "undefined" && typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `draft-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function normalizeTaskType(value: unknown): TaskType {
  if (
    value === "general" ||
    value === "development" ||
    value === "design" ||
    value === "analysis" ||
    value === "presentation" ||
    value === "documentation" ||
    value === "create_mockup" ||
    value === "design_system_update" ||
    value === "color_palette_generate" ||
    value === "typography_review"
  ) {
    return value;
  }
  return "general";
}

export function loadCreateTaskDrafts(): CreateTaskDraft[] {
  const raw = readStoredValue(TASK_CREATE_DRAFTS_STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((row) => typeof row === "object" && row !== null)
      .map((row) => {
        const r = row as Record<string, unknown>;
        return {
          id: typeof r.id === "string" && r.id ? r.id : createDraftId(),
          title: typeof r.title === "string" ? r.title : "",
          description: typeof r.description === "string" ? r.description : "",
          departmentId: typeof r.departmentId === "string" ? r.departmentId : "",
          taskType: normalizeTaskType(r.taskType),
          priority: typeof r.priority === "number" ? Math.min(Math.max(Math.trunc(r.priority), 1), 5) : 3,
          assignAgentId: typeof r.assignAgentId === "string" ? r.assignAgentId : "",
          projectId: typeof r.projectId === "string" ? r.projectId : "",
          projectQuery: typeof r.projectQuery === "string" ? r.projectQuery : "",
          createNewProjectMode: Boolean(r.createNewProjectMode),
          newProjectPath: typeof r.newProjectPath === "string" ? r.newProjectPath : "",
          packInputValues:
            r.packInputValues && typeof r.packInputValues === "object" && !Array.isArray(r.packInputValues)
              ? (r.packInputValues as Record<string, string>)
              : {},
          updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : Date.now(),
        } satisfies CreateTaskDraft;
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 20);
  } catch {
    return [];
  }
}

export function saveCreateTaskDrafts(drafts: CreateTaskDraft[]): void {
  writeStoredValue(TASK_CREATE_DRAFTS_STORAGE_KEY, JSON.stringify(drafts.slice(0, 20)));
}

export const COLUMNS: {
  status: TaskStatus;
  icon: string;
  /** Hex color for dot, text, and tinted backgrounds */
  color: string;
  /** Legacy Tailwind classes — kept for backwards compat but prefer `color` */
  headerBg: string;
  borderColor: string;
  dotColor: string;
}[] = [
  {
    status: "inbox",
    icon: "📥",
    color: "#94A3B8",
    headerBg: "bg-slate-800",
    borderColor: "border-slate-600",
    dotColor: "bg-slate-400",
  },
  {
    status: "planned",
    icon: "📋",
    color: "#60A5FA",
    headerBg: "bg-blue-900",
    borderColor: "border-blue-700",
    dotColor: "bg-blue-400",
  },
  {
    status: "collaborating",
    icon: "🤝",
    color: "#818CF8",
    headerBg: "bg-indigo-900",
    borderColor: "border-indigo-700",
    dotColor: "bg-indigo-400",
  },
  {
    status: "in_progress",
    icon: "⚡",
    color: "#FBBF24",
    headerBg: "bg-amber-900",
    borderColor: "border-amber-700",
    dotColor: "bg-amber-400",
  },
  {
    status: "review",
    icon: "🔍",
    color: "#A78BFA",
    headerBg: "bg-purple-900",
    borderColor: "border-purple-700",
    dotColor: "bg-purple-400",
  },
  {
    status: "done",
    icon: "✅",
    color: "#34D399",
    headerBg: "bg-green-900",
    borderColor: "border-green-700",
    dotColor: "bg-green-400",
  },
  {
    status: "pending",
    icon: "⏸️",
    color: "#FB923C",
    headerBg: "bg-orange-900",
    borderColor: "border-orange-700",
    dotColor: "bg-orange-400",
  },
  {
    status: "cancelled",
    icon: "🚫",
    color: "#F87171",
    headerBg: "bg-red-900",
    borderColor: "border-red-700",
    dotColor: "bg-red-400",
  },
];

export const STATUS_OPTIONS: TaskStatus[] = [
  "inbox",
  "planned",
  "collaborating",
  "in_progress",
  "review",
  "done",
  "pending",
  "cancelled",
];

export const TASK_TYPE_OPTIONS: { value: TaskType; color: string }[] = [
  { value: "general", color: "bg-slate-700 text-slate-300" },
  { value: "development", color: "bg-cyan-900 text-cyan-300" },
  { value: "design", color: "bg-pink-900 text-pink-300" },
  { value: "create_mockup", color: "bg-fuchsia-900 text-fuchsia-300" },
  { value: "design_system_update", color: "bg-violet-900 text-violet-300" },
  { value: "color_palette_generate", color: "bg-rose-900 text-rose-300" },
  { value: "typography_review", color: "bg-amber-900 text-amber-300" },
  { value: "analysis", color: "bg-indigo-900 text-indigo-300" },
  { value: "presentation", color: "bg-orange-900 text-orange-300" },
  { value: "documentation", color: "bg-teal-900 text-teal-300" },
];

export function taskStatusLabel(status: TaskStatus, t: TFunction) {
  switch (status) {
    case "inbox":
      return t({ en: "Inbox", de: "Posteingang" });
    case "planned":
      return t({ en: "Planned", de: "Geplant" });
    case "collaborating":
      return t({ en: "Collaborating", de: "Zusammenarbeit" });
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

export function taskTypeLabel(type: TaskType, t: TFunction) {
  switch (type) {
    case "general":
      return t({ en: "General", de: "Allgemein" });
    case "development":
      return t({ en: "Development", de: "Entwicklung" });
    case "design":
      return t({ en: "Design", de: "Design" });
    case "create_mockup":
      return t({ en: "Create Mockup", de: "Mockup erstellen" });
    case "design_system_update":
      return t({ en: "Design System Update", de: "Design-System aktualisieren" });
    case "color_palette_generate":
      return t({ en: "Color Palette Generate", de: "Farbpalette generieren" });
    case "typography_review":
      return t({ en: "Typography Review", de: "Typografie-Überprüfung" });
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

export function getTaskTypeBadge(type: TaskType, t: TFunction) {
  const option = TASK_TYPE_OPTIONS.find((entry) => entry.value === type) ?? TASK_TYPE_OPTIONS[0];
  return { ...option, label: taskTypeLabel(option.value, t) };
}

export function priorityIcon(priority: number) {
  if (priority >= 4) return "🔴";
  if (priority >= 2) return "🟡";
  return "🟢";
}

export function priorityLabel(priority: number, t: TFunction) {
  if (priority >= 4) return t({ en: "High", de: "Hoch" });
  if (priority >= 2) return t({ en: "Medium", de: "Mittel" });
  return t({ en: "Low", de: "Niedrig" });
}

export function timeAgo(ts: number, localeTag: string): string {
  const diffSec = Math.floor((Date.now() - ts) / 1000);
  const relativeTimeFormat = new Intl.RelativeTimeFormat(localeTag, { numeric: "auto" });
  if (diffSec < 60) return relativeTimeFormat.format(-diffSec, "second");
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return relativeTimeFormat.format(-diffMin, "minute");
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return relativeTimeFormat.format(-diffHour, "hour");
  return relativeTimeFormat.format(-Math.floor(diffHour / 24), "day");
}
