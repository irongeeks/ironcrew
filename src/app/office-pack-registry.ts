import type { Agent, Department, PackRegistryEntry, RoomTheme, WorkflowPackKey } from "../types";
import type { DeptPreset, Localized, OfficePackPresentation, PackPreset, UiLanguageLike } from "./office-pack-presets";
import { PACK_PRESETS } from "./office-pack-presets";
import { PACK_NAME_POOL_OVERRIDES } from "./office-pack-name-pools";
import { buildPackDepartmentDescription, buildPackDepartmentPrompt, pickText } from "./office-pack-localization";

export function buildPresetFromRegistryEntry(entry: PackRegistryEntry): PackPreset {
  const depts: Partial<Record<string, DeptPreset>> = {};
  for (const [deptId, deptUi] of Object.entries(entry.ui.departments)) {
    depts[deptId] = {
      name: (deptUi.name ?? { en: deptId }) as Localized,
      icon: deptUi.icon ?? "📦",
      agentPrefix: (deptUi.agent_prefix ?? { en: deptId }) as Localized,
      avatarPool: deptUi.avatar_pool ?? ["📦"],
    };
  }

  const roomThemes: Record<string, RoomTheme> = {};
  const toNum = (v: number | string | undefined, fallback: number): number => {
    if (v === undefined) return fallback;
    if (typeof v === "number") return v;
    return parseInt(v.replace(/^#/, ""), 16) || fallback;
  };
  for (const [roomId, theme] of Object.entries(entry.ui.room_themes)) {
    roomThemes[roomId] = {
      floor1: toNum(theme.floor1, 0xe0e0e0),
      floor2: toNum(theme.floor2, 0xd5d5d5),
      wall: toNum(theme.wall, 0x808080),
      accent: toNum(theme.accent, 0x5a9fd4),
    };
  }

  return {
    key: entry.key as WorkflowPackKey,
    slug: entry.ui.slug,
    label: entry.ui.label as Localized,
    summary: entry.ui.summary as Localized,
    roomThemes,
    departments: depts,
    staff: {
      nonLeaderDeptCycle: entry.ui.staff_cycle,
    },
  };
}

export function buildNamePoolFromRegistry(entry: PackRegistryEntry): Partial<Record<string, Localized[]>> | null {
  if (!entry.staff?.name_pool?.length) return null;
  const pool: Partial<Record<string, Localized[]>> = {};
  for (const member of entry.staff.name_pool) {
    const dept = member.department;
    if (!pool[dept]) pool[dept] = [];
    pool[dept]!.push(member.name as Localized);
  }
  return pool;
}

export function mergeRegistryIntoPresets(registry: PackRegistryEntry[]): Record<string, PackPreset> {
  const merged: Record<string, PackPreset> = { ...PACK_PRESETS };
  for (const entry of registry) {
    if (entry.source === "community" && !(entry.key in merged)) {
      merged[entry.key] = buildPresetFromRegistryEntry(entry);
    } else if (entry.source === "built-in" && entry.ui?.departments && Object.keys(entry.ui.departments).length > 0) {
      // Merge registry UI data into built-in presets so pack.yaml department IDs take effect
      merged[entry.key] = { ...merged[entry.key], ...buildPresetFromRegistryEntry(entry) };
    }
  }
  return merged;
}

export function mergeNamePoolOverrides(
  registry: PackRegistryEntry[],
): Partial<Record<string, Partial<Record<string, Localized[]>>>> {
  const merged = { ...PACK_NAME_POOL_OVERRIDES };
  for (const entry of registry) {
    if (!(entry.key in merged)) {
      const pool = buildNamePoolFromRegistry(entry);
      if (pool) merged[entry.key] = pool;
    }
  }
  return merged;
}

export function normalizeOfficeWorkflowPack(value: unknown, knownKeys?: Record<string, unknown>): WorkflowPackKey {
  if (typeof value !== "string") return "development";
  const lookup = knownKeys ?? PACK_PRESETS;
  return value in lookup ? value : "development";
}

export function getOfficePackMeta(packKey: WorkflowPackKey): { label: Localized; summary: Localized } {
  const preset = PACK_PRESETS[packKey] ?? PACK_PRESETS.development;
  return { label: preset.label, summary: preset.summary };
}

export function getOfficePackRoomThemes(packKey: WorkflowPackKey): Record<string, RoomTheme> {
  const preset = PACK_PRESETS[packKey] ?? PACK_PRESETS.development;
  return preset.roomThemes;
}

export function listOfficePackOptions(
  locale: UiLanguageLike,
  presets?: Record<string, PackPreset>,
): Array<{
  key: WorkflowPackKey;
  label: string;
  summary: string;
  slug: string;
  accent: number;
}> {
  const source = presets ?? PACK_PRESETS;
  return Object.keys(source).map((key) => ({
    key,
    label: pickText(locale, source[key].label),
    summary: pickText(locale, source[key].summary),
    slug: source[key].slug,
    accent: source[key].roomThemes.ceoOffice?.accent ?? source[key].roomThemes.planning?.accent ?? 0x5a9fd4,
  }));
}

export function buildOfficePackPresentation(params: {
  packKey: WorkflowPackKey;
  locale: UiLanguageLike;
  departments: Department[];
  agents: Agent[];
  customRoomThemes: Record<string, RoomTheme>;
}): OfficePackPresentation {
  const { packKey, locale, departments, agents, customRoomThemes } = params;
  if (packKey === "development") {
    return {
      departments,
      agents,
      roomThemes: customRoomThemes,
    };
  }

  const preset = PACK_PRESETS[packKey] ?? PACK_PRESETS.development;
  const transformedDepartments = departments.map((dept) => {
    const deptPreset = preset.departments[dept.id];
    if (!deptPreset) return dept;
    const localizedName: Localized = {
      ko: deptPreset.name.ko || dept.name_ko || dept.name,
      en: deptPreset.name.en || dept.name,
      ja: deptPreset.name.ja || dept.name_ja || dept.name,
      zh: deptPreset.name.zh || dept.name_zh || dept.name,
    };
    return {
      ...dept,
      icon: deptPreset.icon,
      name: deptPreset.name.en,
      name_ko: deptPreset.name.ko,
      name_ja: deptPreset.name.ja,
      name_zh: deptPreset.name.zh,
      description: buildPackDepartmentDescription({
        locale,
        packSummary: preset.summary,
        departmentName: localizedName,
      }),
      prompt: buildPackDepartmentPrompt({
        locale,
        packSummary: preset.summary,
        departmentName: localizedName,
      }),
    };
  });

  return {
    departments: transformedDepartments,
    agents,
    roomThemes: {
      ...customRoomThemes,
      ...preset.roomThemes,
    },
  };
}
