import type {
  Agent,
  CompanySettings,
  MessengerChannelConfig,
  MessengerChannelsConfig,
  RoomTheme,
  SubTask,
  Task,
} from "../types";
import { DEFAULT_SETTINGS, MESSENGER_CHANNELS } from "../types";
import { LANGUAGE_STORAGE_KEY, LANGUAGE_USER_SET_STORAGE_KEY, normalizeLanguage } from "../i18n";
import type { RoomThemeMap, RuntimeOs } from "./types";
import { ROOM_THEMES_STORAGE_KEY } from "./constants";
import { readStoredValue, writeStoredValue } from "../storage";

function isRoomTheme(value: unknown): value is RoomTheme {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.floor1 === "number" &&
    Number.isFinite(v.floor1) &&
    typeof v.floor2 === "number" &&
    Number.isFinite(v.floor2) &&
    typeof v.wall === "number" &&
    Number.isFinite(v.wall) &&
    typeof v.accent === "number" &&
    Number.isFinite(v.accent)
  );
}

export function isRoomThemeMap(value: unknown): value is RoomThemeMap {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every(isRoomTheme);
}

export function readStoredRoomThemes(): { themes: RoomThemeMap; hasStored: boolean } {
  const raw = readStoredValue(ROOM_THEMES_STORAGE_KEY);
  if (!raw) return { themes: {}, hasStored: false };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRoomThemeMap(parsed)) return { themes: {}, hasStored: false };
    return { themes: parsed, hasStored: true };
  } catch {
    return { themes: {}, hasStored: false };
  }
}

export function appendCapped<T>(prev: T[], item: T, max: number): T[] {
  const next = prev.length >= max ? prev.slice(prev.length - max + 1) : prev.slice();
  next.push(item);
  return next;
}

function areValuesEquivalent(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return Object.is(a, b);
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function areExtraFieldsEquivalent(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  comparedKeys: ReadonlySet<string>,
): boolean {
  const keys = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (comparedKeys.has(key)) continue;
    if (!areValuesEquivalent(a[key], b[key])) return false;
  }
  return true;
}

const AGENT_EQ_KNOWN_KEYS = new Set<string>([
  "id",
  "name",
  "name_ko",
  "department_id",
  "role",
  "cli_provider",
  "oauth_account_id",
  "api_provider_id",
  "api_model",
  "cli_model",
  "cli_reasoning_level",
  "avatar_emoji",
  "personality",
  "status",
  "current_task_id",
  "created_at",
]);

const TASK_EQ_KNOWN_KEYS = new Set<string>([
  "id",
  "title",
  "description",
  "department_id",
  "assigned_agent_id",
  "project_id",
  "status",
  "priority",
  "task_type",
  "project_path",
  "result",
  "started_at",
  "completed_at",
  "created_at",
  "updated_at",
  "source_task_id",
  "subtask_total",
  "subtask_done",
  "hidden",
]);

export function areAgentsEquivalent(a: Agent, b: Agent): boolean {
  if (
    a.id === b.id &&
    a.name === b.name &&
    a.name_ko === b.name_ko &&
    a.department_id === b.department_id &&
    a.role === b.role &&
    a.cli_provider === b.cli_provider &&
    (a.oauth_account_id ?? null) === (b.oauth_account_id ?? null) &&
    (a.api_provider_id ?? null) === (b.api_provider_id ?? null) &&
    (a.api_model ?? null) === (b.api_model ?? null) &&
    (a.cli_model ?? null) === (b.cli_model ?? null) &&
    (a.cli_reasoning_level ?? null) === (b.cli_reasoning_level ?? null) &&
    a.avatar_emoji === b.avatar_emoji &&
    (a.personality ?? null) === (b.personality ?? null) &&
    a.status === b.status &&
    (a.current_task_id ?? null) === (b.current_task_id ?? null) &&
    a.created_at === b.created_at
  ) {
    return areExtraFieldsEquivalent(
      a as unknown as Record<string, unknown>,
      b as unknown as Record<string, unknown>,
      AGENT_EQ_KNOWN_KEYS,
    );
  }
  return false;
}

export function areAgentListsEquivalent(prev: Agent[], next: Agent[]): boolean {
  if (prev === next) return true;
  if (prev.length !== next.length) return false;
  for (let i = 0; i < prev.length; i += 1) {
    if (!areAgentsEquivalent(prev[i], next[i])) return false;
  }
  return true;
}

function areTasksEquivalent(a: Task, b: Task): boolean {
  if (
    a.id === b.id &&
    a.title === b.title &&
    (a.description ?? null) === (b.description ?? null) &&
    (a.department_id ?? null) === (b.department_id ?? null) &&
    (a.assigned_agent_id ?? null) === (b.assigned_agent_id ?? null) &&
    (a.project_id ?? null) === (b.project_id ?? null) &&
    a.status === b.status &&
    a.priority === b.priority &&
    a.task_type === b.task_type &&
    (a.project_path ?? null) === (b.project_path ?? null) &&
    (a.result ?? null) === (b.result ?? null) &&
    (a.started_at ?? null) === (b.started_at ?? null) &&
    (a.completed_at ?? null) === (b.completed_at ?? null) &&
    a.created_at === b.created_at &&
    a.updated_at === b.updated_at &&
    (a.source_task_id ?? null) === (b.source_task_id ?? null) &&
    (a.subtask_total ?? null) === (b.subtask_total ?? null) &&
    (a.subtask_done ?? null) === (b.subtask_done ?? null) &&
    (a.hidden ?? 0) === (b.hidden ?? 0)
  ) {
    return areExtraFieldsEquivalent(
      a as unknown as Record<string, unknown>,
      b as unknown as Record<string, unknown>,
      TASK_EQ_KNOWN_KEYS,
    );
  }
  return false;
}

export function areTaskListsEquivalent(prev: Task[], next: Task[]): boolean {
  if (prev === next) return true;
  if (prev.length !== next.length) return false;
  for (let i = 0; i < prev.length; i += 1) {
    if (!areTasksEquivalent(prev[i], next[i])) return false;
  }
  return true;
}

const SUBTASK_EQ_KNOWN_KEYS = new Set<string>([
  "id",
  "task_id",
  "title",
  "description",
  "status",
  "assigned_agent_id",
  "blocked_reason",
  "cli_tool_use_id",
  "target_department_id",
  "delegated_task_id",
  "created_at",
  "completed_at",
]);

function areSubtasksEquivalent(a: SubTask, b: SubTask): boolean {
  if (
    a.id === b.id &&
    a.task_id === b.task_id &&
    a.title === b.title &&
    (a.description ?? null) === (b.description ?? null) &&
    a.status === b.status &&
    (a.assigned_agent_id ?? null) === (b.assigned_agent_id ?? null) &&
    (a.blocked_reason ?? null) === (b.blocked_reason ?? null) &&
    (a.cli_tool_use_id ?? null) === (b.cli_tool_use_id ?? null) &&
    (a.target_department_id ?? null) === (b.target_department_id ?? null) &&
    (a.delegated_task_id ?? null) === (b.delegated_task_id ?? null) &&
    a.created_at === b.created_at &&
    (a.completed_at ?? null) === (b.completed_at ?? null)
  ) {
    return areExtraFieldsEquivalent(
      a as unknown as Record<string, unknown>,
      b as unknown as Record<string, unknown>,
      SUBTASK_EQ_KNOWN_KEYS,
    );
  }
  return false;
}

export function areSubtaskListsEquivalent(prev: SubTask[], next: SubTask[]): boolean {
  if (prev === next) return true;
  if (prev.length !== next.length) return false;
  for (let i = 0; i < prev.length; i += 1) {
    if (!areSubtasksEquivalent(prev[i], next[i])) return false;
  }
  return true;
}

export function mergeSettingsWithDefaults(settings?: Partial<CompanySettings> | null): CompanySettings {
  const mergedMessengerChannels = MESSENGER_CHANNELS.reduce<MessengerChannelsConfig>((acc, channel) => {
    const defaults = DEFAULT_SETTINGS.messengerChannels?.[channel] ?? {
      token: "",
      sessions: [],
      receiveEnabled: false,
    };
    const incoming: Partial<MessengerChannelConfig> = settings?.messengerChannels?.[channel] ?? {};
    acc[channel] = {
      ...defaults,
      ...incoming,
      sessions: incoming.sessions ?? defaults.sessions ?? [],
    };
    return acc;
  }, {} as MessengerChannelsConfig);

  return {
    ...DEFAULT_SETTINGS,
    ...(settings ?? {}),
    language: normalizeLanguage(settings?.language ?? DEFAULT_SETTINGS.language),
    providerModelConfig: {
      ...(DEFAULT_SETTINGS.providerModelConfig ?? {}),
      ...(settings?.providerModelConfig ?? {}),
    },
    messengerChannels: mergedMessengerChannels,
  };
}

export function isUserLanguagePinned(): boolean {
  return readStoredValue(LANGUAGE_USER_SET_STORAGE_KEY) === "1";
}

export function readStoredClientLanguage(): string | null {
  const raw = readStoredValue(LANGUAGE_STORAGE_KEY);
  if (!raw) return null;
  return normalizeLanguage(raw);
}

export function detectRuntimeOs(): RuntimeOs {
  if (typeof window === "undefined") return "unknown";
  const ua = (window.navigator.userAgent || "").toLowerCase();
  const platform = (window.navigator.platform || "").toLowerCase();
  if (platform.includes("win") || ua.includes("windows")) return "windows";
  if (platform.includes("mac") || ua.includes("mac os")) return "mac";
  if (platform.includes("linux") || ua.includes("linux")) return "linux";
  return "unknown";
}

export function isForceUpdateBannerEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get("force_update_banner") === "1";
  } catch {
    return false;
  }
}

export function syncClientLanguage(language: string): void {
  if (typeof window === "undefined") return;
  writeStoredValue(LANGUAGE_STORAGE_KEY, normalizeLanguage(language));
  window.dispatchEvent(new Event("ironcrew-language-change"));
}
