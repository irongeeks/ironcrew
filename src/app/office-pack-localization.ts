import type { AgentRole, WorkflowPackKey } from "../types";
import type { Localized, UiLanguageLike } from "./office-pack-presets";
import { PACK_SEED_PROFILE } from "./office-pack-presets";
import { DEPARTMENT_PERSON_NAME_POOL, PACK_NAME_POOL_OVERRIDES } from "./office-pack-name-pools";

export function pickText(locale: UiLanguageLike, text: Localized): string {
  return locale === "de" ? text.de || text.en : text.en;
}

export function localizedNumberedName(
  _locale: UiLanguageLike,
  prefix: Localized,
  order: number,
): { name: string; name_ko: string; name_ja: string; name_zh: string } {
  return {
    name: `${prefix.en} ${order}`,
    name_ko: `${prefix.ko} ${order}`,
    name_ja: `${prefix.ja} ${order}`,
    name_zh: `${prefix.zh} ${order}`,
  };
}

export function localizedStaffDisplayName(params: {
  packKey: WorkflowPackKey;
  deptId: string;
  order: number;
  fallbackPrefix: Localized;
}): { name: string; name_ko: string; name_ja: string; name_zh: string } {
  const { packKey, deptId, order, fallbackPrefix } = params;
  const packOverride = PACK_NAME_POOL_OVERRIDES[packKey]?.[deptId];
  const pool = packOverride ?? DEPARTMENT_PERSON_NAME_POOL[deptId];
  if (!pool || pool.length === 0) {
    return localizedNumberedName("en", fallbackPrefix, order);
  }
  const seedOffset = packOverride ? 0 : (PACK_SEED_PROFILE[packKey]?.nameOffset ?? 0);
  const base = pool[(order - 1 + seedOffset) % pool.length] ?? pool[0];
  const cycle = Math.floor((order - 1) / pool.length) + 1;
  const suffix = cycle > 1 ? ` ${cycle}` : "";
  return {
    name: `${base.en}${suffix}`,
    name_ko: `${base.ko}${suffix}`,
    name_ja: `${base.ja}${suffix}`,
    name_zh: `${base.zh}${suffix}`,
  };
}

export function buildSeedPersonality(params: {
  packKey: WorkflowPackKey;
  deptId: string;
  role: AgentRole;
  locale: UiLanguageLike;
  defaultPrefix: Localized;
  departmentName: Localized;
}): string | null {
  if (params.packKey === "development") return null;
  const tone = PACK_SEED_PROFILE[params.packKey]?.tone;
  if (!tone) return null;
  const locale = params.locale;
  const roleLabelMap: Record<UiLanguageLike, Record<AgentRole, string>> = {
    en: {
      team_leader: "team lead",
      senior: "senior member",
      junior: "junior member",
      intern: "intern",
    },
    de: {
      team_leader: "Teamleiter",
      senior: "Senior",
      junior: "Junior",
      intern: "Praktikant",
    },
  };
  const focusByLocale: Record<UiLanguageLike, string> = {
    en: params.defaultPrefix.en?.trim() || `${params.departmentName.en} coverage`,
    de:
      params.defaultPrefix.de?.trim() ||
      params.defaultPrefix.en?.trim() ||
      `${params.departmentName.de || params.departmentName.en}`,
  };
  const roleLabel = roleLabelMap[locale][params.role];
  const focus = focusByLocale[locale];
  const toneText = pickText(locale, tone);
  if (locale === "de") return `${toneText} Arbeitet als ${roleLabel} mit Fokus auf ${focus}.`;
  return `${toneText} Serves as a ${roleLabel} focused on ${focus}.`;
}

export function buildPackDepartmentDescription(params: {
  locale: UiLanguageLike;
  packSummary: Localized;
  departmentName: Localized;
}): string {
  const { locale, packSummary, departmentName } = params;
  const summary = pickText(locale, packSummary);
  const deptName = pickText(locale, departmentName);
  if (locale === "de") return `${deptName}: Arbeitet gemeinsam an folgendem Ziel: ${summary}.`;
  return `${deptName} team. Collaborates to deliver the ${summary.toLowerCase()} goal.`;
}

export function buildPackDepartmentPrompt(params: {
  locale: UiLanguageLike;
  packSummary: Localized;
  departmentName: Localized;
}): string {
  const { locale, packSummary, departmentName } = params;
  const summary = pickText(locale, packSummary);
  const deptName = pickText(locale, departmentName);
  if (locale === "de") {
    return `[Abteilungsrolle] ${deptName}\n[Arbeitsgrundlage] ${summary}\nZerlege Anfragen in umsetzbare Schritte und benenne Begründungen und Ergebnisse klar.`;
  }
  return `[Department Role] ${deptName}\n[Execution Standard] ${summary}\nBreak requests into actionable steps and clearly provide rationale and deliverables.`;
}
