import type { TaskStatus, TaskType } from "../../types";
import type { LangText, UiLanguage } from "../../i18n";

export type Locale = UiLanguage;
export type TFunction = (messages: LangText) => string;

const TASK_CREATE_DRAFTS_STORAGE_KEY = "octooffice.taskCreateDrafts";

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
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(TASK_CREATE_DRAFTS_STORAGE_KEY);
    if (!raw) return [];
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
  if (typeof window === "undefined") return;
  window.localStorage.setItem(TASK_CREATE_DRAFTS_STORAGE_KEY, JSON.stringify(drafts.slice(0, 20)));
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
      return t({ ko: "수신함", en: "Inbox", ja: "受信箱", zh: "Inbox", de: "Posteingang" });
    case "planned":
      return t({ ko: "계획됨", en: "Planned", ja: "計画済み", zh: "Planned", de: "Geplant" });
    case "collaborating":
      return t({ ko: "협업 중", en: "Collaborating", ja: "協業中", zh: "Collaborating", de: "Zusammenarbeit" });
    case "in_progress":
      return t({ ko: "진행 중", en: "In Progress", ja: "進行中", zh: "In Progress", de: "In Arbeit" });
    case "review":
      return t({ ko: "검토", en: "Review", ja: "レビュー", zh: "Review", de: "Überprüfung" });
    case "done":
      return t({ ko: "완료", en: "Done", ja: "完了", zh: "Done", de: "Erledigt" });
    case "pending":
      return t({ ko: "보류", en: "Pending", ja: "保留", zh: "Pending", de: "Ausstehend" });
    case "cancelled":
      return t({ ko: "취소", en: "Cancelled", ja: "キャンセル", zh: "Cancelled", de: "Abgebrochen" });
    default:
      return status;
  }
}

export function taskTypeLabel(type: TaskType, t: TFunction) {
  switch (type) {
    case "general":
      return t({ ko: "일반", en: "General", ja: "一般", zh: "General", de: "Allgemein" });
    case "development":
      return t({ ko: "개발", en: "Development", ja: "開発", zh: "Development", de: "Entwicklung" });
    case "design":
      return t({ ko: "디자인", en: "Design", ja: "デザイン", zh: "Design", de: "Design" });
    case "create_mockup":
      return t({
        ko: "목업 제작",
        en: "Create Mockup",
        ja: "モックアップ作成",
        zh: "Create Mockup",
        de: "Mockup erstellen",
      });
    case "design_system_update":
      return t({
        ko: "디자인 시스템 업데이트",
        en: "Design System Update",
        ja: "デザインシステム更新",
        zh: "Design System Update",
        de: "Design-System aktualisieren",
      });
    case "color_palette_generate":
      return t({
        ko: "컬러 팔레트 생성",
        en: "Color Palette Generate",
        ja: "カラーパレット生成",
        zh: "Color Palette Generate",
        de: "Farbpalette generieren",
      });
    case "typography_review":
      return t({
        ko: "타이포그래피 리뷰",
        en: "Typography Review",
        ja: "タイポグラフィレビュー",
        zh: "Typography Review",
        de: "Typografie-Überprüfung",
      });
    case "analysis":
      return t({ ko: "분석", en: "Analysis", ja: "分析", zh: "Analysis", de: "Analyse" });
    case "presentation":
      return t({ ko: "발표", en: "Presentation", ja: "プレゼン", zh: "Presentation", de: "Präsentation" });
    case "documentation":
      return t({ ko: "문서화", en: "Documentation", ja: "文書化", zh: "Documentation", de: "Dokumentation" });
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
  if (priority >= 4) return t({ ko: "높음", en: "High", ja: "高", zh: "High", de: "Hoch" });
  if (priority >= 2) return t({ ko: "중간", en: "Medium", ja: "中", zh: "Medium", de: "Mittel" });
  return t({ ko: "낮음", en: "Low", ja: "低", zh: "Low", de: "Niedrig" });
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
