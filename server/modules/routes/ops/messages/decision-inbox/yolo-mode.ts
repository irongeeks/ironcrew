import type { DecisionInboxRouteItem } from "./types.ts";

export type DecisionApplyResult = {
  status: number;
  payload: Record<string, unknown>;
};

export type YoloDecisionReplyPayload = {
  option_number: number;
  selected_option_numbers?: number[];
};

const RETRYABLE_DECISION_ERRORS = new Set<string>([
  "decision_options_not_ready",
  "option_not_found",
  "project_task_options_pending",
  "project_not_ready_for_review_meeting",
  "meeting_not_pending",
  "task_not_in_review",
]);
const RETRYABLE_ERROR_MAX_ATTEMPTS_PER_DECISION = 6;

function normalizeBooleanLike(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const text = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!text) return null;
  if (["true", "1", "yes", "on", "enable", "enabled"].includes(text)) return true;
  if (["false", "0", "no", "off", "disable", "disabled"].includes(text)) return false;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === "boolean") return parsed;
    if (typeof parsed === "number") return parsed !== 0;
  } catch {
    // ignore JSON parse errors
  }
  return null;
}

export function readYoloModeEnabled(db: { prepare: (sql: string) => { get: (...args: any[]) => unknown } }): boolean {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'yoloMode' LIMIT 1").get() as
    | { value?: unknown }
    | undefined;
  return normalizeBooleanLike(row?.value) === true;
}

function extractSummarySuggestedOptionNumbers(summary: string, validNumbers: Set<number>): number[] {
  const text = String(summary ?? "");
  const picked: number[] = [];
  const seen = new Set<number>();
  const addIfValid = (value: number) => {
    if (!validNumbers.has(value)) return;
    if (seen.has(value)) return;
    seen.add(value);
    picked.push(value);
  };

  for (const match of text.matchAll(/^\s*([1-9]\d?)\s*[.)]/gm)) {
    const value = Number.parseInt(match[1] || "", 10);
    if (Number.isFinite(value)) addIfValid(value);
  }
  for (const match of text.matchAll(/(?:option|옵션|번호|pick(?:s)?|선택)\s*[:#-]?\s*([1-9]\d?)/gi)) {
    const value = Number.parseInt(match[1] || "", 10);
    if (Number.isFinite(value)) addIfValid(value);
  }
  for (const match of text.matchAll(/(?:recommend(?:ed)?|권장|추천|pick(?:s)?)\s*[:：-]\s*([^\n]+)/gi)) {
    const block = String(match[1] || "");
    for (const numMatch of block.matchAll(/([1-9]\d?)/g)) {
      const value = Number.parseInt(numMatch[1] || "", 10);
      if (Number.isFinite(value)) addIfValid(value);
    }
  }

  return picked;
}

export function buildYoloDecisionReplyPayload(item: DecisionInboxRouteItem): YoloDecisionReplyPayload | null {
  if (!Array.isArray(item.options) || item.options.length <= 0) return null;

  if (item.kind === "task_timeout_resume") {
    const resume = item.options.find((option) => option.action === "resume_timeout_task") ?? item.options[0];
    return resume ? { option_number: resume.number } : null;
  }

  if (item.kind === "project_review_ready") {
    const representativeOptions = item.options.filter((option) => option.action.startsWith("approve_task_review:"));
    if (representativeOptions.length > 0) {
      const validNumbers = new Set(representativeOptions.map((option) => option.number));
      const suggested = extractSummarySuggestedOptionNumbers(item.summary, validNumbers);
      const pickedNumber = suggested[0] ?? representativeOptions[0]?.number;
      if (!pickedNumber) return null;
      return { option_number: pickedNumber };
    }

    const startReview = item.options.find((option) => option.action === "start_project_review");
    if (startReview) return { option_number: startReview.number };
    return null;
  }

  if (item.kind === "review_round_pick") {
    const pickOptions = item.options.filter((option) => option.action === "apply_review_pick");
    if (pickOptions.length > 0) {
      const validNumbers = new Set(pickOptions.map((option) => option.number));
      const suggested = extractSummarySuggestedOptionNumbers(item.summary, validNumbers);
      const selected = suggested.length > 0 ? suggested : [pickOptions[0].number];
      return {
        option_number: selected[0],
        selected_option_numbers: selected,
      };
    }

    const skip = item.options.find((option) => option.action === "skip_to_next_round");
    if (skip) return { option_number: skip.number };
    return null;
  }

  return null;
}

export async function runYoloDecisionAutopilot(input: {
  getDecisionInboxItems: () => DecisionInboxRouteItem[];
  applyDecisionReply: (decisionId: string, body: Record<string, unknown>) => Promise<DecisionApplyResult>;
  maxSteps?: number;
  shouldSkipItem?: (item: DecisionInboxRouteItem) => boolean;
}): Promise<number> {
  const maxSteps = Math.max(1, Math.min(Math.trunc(input.maxSteps ?? 24), 120));
  const failedDecisionIds = new Set<string>();
  const retryableAttemptCountByDecisionId = new Map<string, number>();
  let appliedCount = 0;

  for (let step = 0; step < maxSteps; step += 1) {
    const items = input
      .getDecisionInboxItems()
      .slice()
      .sort((a, b) => a.created_at - b.created_at)
      .filter((item) => !failedDecisionIds.has(item.id))
      .filter((item) => !(input.shouldSkipItem?.(item) ?? false));

    let chosen: { id: string; payload: YoloDecisionReplyPayload } | null = null;
    for (const item of items) {
      const payload = buildYoloDecisionReplyPayload(item);
      if (!payload) continue;
      chosen = { id: item.id, payload };
      break;
    }

    if (!chosen) break;

    const result = await input.applyDecisionReply(chosen.id, chosen.payload);
    if (result.status >= 400) {
      const errorCode = String((result.payload as { error?: unknown } | null | undefined)?.error ?? "").trim();
      if (errorCode && RETRYABLE_DECISION_ERRORS.has(errorCode)) {
        const attempt = (retryableAttemptCountByDecisionId.get(chosen.id) ?? 0) + 1;
        if (attempt >= RETRYABLE_ERROR_MAX_ATTEMPTS_PER_DECISION) {
          failedDecisionIds.add(chosen.id);
          retryableAttemptCountByDecisionId.delete(chosen.id);
        } else {
          retryableAttemptCountByDecisionId.set(chosen.id, attempt);
        }
        continue;
      }
      retryableAttemptCountByDecisionId.delete(chosen.id);
      failedDecisionIds.add(chosen.id);
      continue;
    }

    retryableAttemptCountByDecisionId.delete(chosen.id);
    appliedCount += 1;
  }

  return appliedCount;
}
