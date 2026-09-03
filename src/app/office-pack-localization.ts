import type { AgentRole, WorkflowPackKey } from "../types";
import type { Localized, UiLanguageLike } from "./office-pack-presets";
import { PACK_SEED_PROFILE } from "./office-pack-presets";
import { DEPARTMENT_PERSON_NAME_POOL, PACK_NAME_POOL_OVERRIDES } from "./office-pack-name-pools";

export function pickText(locale: UiLanguageLike, text: Localized): string {
  switch (locale) {
    case "ko":
      return text.ko;
    case "ja":
      return text.ja || text.en;
    case "zh":
      return text.zh || text.en;
    case "de":
      return text.de || text.en;
    case "en":
    default:
      return text.en;
  }
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
  departmentName: { ko: string; en: string; ja: string; zh: string };
}): string | null {
  if (params.packKey === "development") return null;
  const tone = PACK_SEED_PROFILE[params.packKey]?.tone;
  if (!tone) return null;
  const locale = params.locale;
  const roleLabelMap: Record<UiLanguageLike, Record<AgentRole, string>> = {
    ko: {
      team_leader: "팀 리드",
      senior: "시니어",
      junior: "주니어",
      intern: "인턴",
    },
    en: {
      team_leader: "team lead",
      senior: "senior member",
      junior: "junior member",
      intern: "intern",
    },
    ja: {
      team_leader: "チームリーダー",
      senior: "シニア",
      junior: "ジュニア",
      intern: "インターン",
    },
    zh: {
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
    ko: params.defaultPrefix.ko?.trim() || `${params.departmentName.ko} 담당`,
    en: params.defaultPrefix.en?.trim() || `${params.departmentName.en} coverage`,
    ja: params.defaultPrefix.ja?.trim() || `${params.departmentName.ja}担当`,
    zh: params.defaultPrefix.zh?.trim() || `${params.departmentName.zh} coverage`,
    de: params.defaultPrefix.de?.trim() || params.defaultPrefix.en?.trim() || `${params.departmentName.en} coverage`,
  };
  const roleLabel = roleLabelMap[locale][params.role];
  const focus = focusByLocale[locale];
  const toneText = pickText(locale, tone);
  if (locale === "ko") return `${toneText} ${focus} 역할의 ${roleLabel}입니다.`;
  if (locale === "ja") return `${toneText} ${focus}を担当する${roleLabel}として動きます。`;
  if (locale === "zh") return `${toneText} Serves as a ${roleLabel} focused on ${focus}.`;
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
  if (locale === "ko") return `${deptName}입니다. ${summary} 목표를 중심으로 협업합니다.`;
  if (locale === "ja") return `${deptName}です。${summary}の目標達成に向けて連携します。`;
  if (locale === "zh") return `${deptName} team. Collaborates to deliver the ${summary.toLowerCase()} goal.`;
  if (locale === "de") return `${deptName} Team. Collaborates to deliver the ${summary.toLowerCase()} goal.`;
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
  if (locale === "ko") {
    return `[부서 역할] ${deptName}\n[업무 기준] ${summary}\n요청을 실행 가능한 단계로 나누고, 근거와 산출물을 명확히 제시하세요.`;
  }
  if (locale === "ja") {
    return `[部署の役割] ${deptName}\n[業務基準] ${summary}\n依頼を実行可能なステップに分解し、根拠と成果物を明確に提示してください。`;
  }
  if (locale === "zh") {
    return `[Department Role] ${deptName}\n[Execution Standard] ${summary}\nBreak requests into actionable steps and clearly provide rationale and deliverables.`;
  }
  if (locale === "de") {
    return `[Department Role] ${deptName}\n[Execution Standard] ${summary}\nBreak requests into actionable steps and clearly provide rationale and deliverables.`;
  }
  return `[Department Role] ${deptName}\n[Execution Standard] ${summary}\nBreak requests into actionable steps and clearly provide rationale and deliverables.`;
}
