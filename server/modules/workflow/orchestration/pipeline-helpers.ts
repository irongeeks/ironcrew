/**
 * Department Pipeline & Auto-Retry helpers.
 *
 * These utilities parse, update, and query the `workflow_meta_json`
 * fields that drive the configurable department pipeline and the
 * automatic retry/reassign feature.
 */

import type { DatabaseSync } from "node:sqlite";

// ── Types ──────────────────────────────────────────────────────────

export interface PipelineMeta {
  steps: string[];
  current_step: number;
  step_results: Record<string, string>;
  original_agent_id?: string;
  preserve_worktree?: boolean;
}

export interface AutoRetryMeta {
  enabled: boolean;
  max: number;
  count: number;
  failed_agents: string[];
}

export interface WorkflowMeta {
  pipeline?: PipelineMeta;
  auto_retry?: AutoRetryMeta;
  video_phase_transition?: {
    next_phase_id: string;
    next_department_id: string;
  };
  [key: string]: unknown;
}

// ── Parse / Update ─────────────────────────────────────────────────

export function parseWorkflowMeta(raw: string | null | undefined): WorkflowMeta {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as WorkflowMeta;
    }
  } catch {
    /* ignore malformed JSON */
  }
  return {};
}

export function updateWorkflowMeta(
  db: Pick<DatabaseSync, "prepare" | "exec">,
  taskId: string,
  updates: Partial<WorkflowMeta>,
  nowMs: number,
): void {
  db.exec("SAVEPOINT meta_update");
  try {
    const row = db.prepare("SELECT workflow_meta_json FROM tasks WHERE id = ?").get(taskId) as
      | { workflow_meta_json?: string | null }
      | undefined;
    const existing = parseWorkflowMeta(row?.workflow_meta_json);
    const merged = { ...existing, ...updates };
    db.prepare("UPDATE tasks SET workflow_meta_json = ?, updated_at = ? WHERE id = ?").run(
      JSON.stringify(merged),
      nowMs,
      taskId,
    );
    db.exec("RELEASE meta_update");
  } catch (err) {
    db.exec("ROLLBACK TO meta_update");
    throw err;
  }
}

// ── Pipeline Queries ───────────────────────────────────────────────

export function hasPipeline(meta: WorkflowMeta): meta is WorkflowMeta & { pipeline: PipelineMeta } {
  return !!meta.pipeline && Array.isArray(meta.pipeline.steps) && meta.pipeline.steps.length > 0;
}

export function isPipelineComplete(pipeline: PipelineMeta): boolean {
  return pipeline.current_step >= pipeline.steps.length;
}

export function getCurrentPipelineDept(pipeline: PipelineMeta): string | null {
  if (pipeline.current_step >= pipeline.steps.length) return null;
  return pipeline.steps[pipeline.current_step] ?? null;
}

function getNextPipelineDept(pipeline: PipelineMeta): string | null {
  const next = pipeline.current_step + 1;
  if (next >= pipeline.steps.length) return null;
  return pipeline.steps[next] ?? null;
}

/**
 * Determine whether the worktree should be preserved for the next step.
 * QA departments need the dev agent's code, so we keep the worktree.
 */
export function shouldPreserveWorktreeForNextStep(pipeline: PipelineMeta): boolean {
  const nextDept = getNextPipelineDept(pipeline);
  return nextDept === "qa" || nextDept === "browser";
}

// ── Pipeline Step Prompt Prefixes ──────────────────────────────────

const STEP_PROMPT_PREFIXES: Record<string, { en: string; ko: string; ja: string; zh: string }> = {
  planning: {
    en: "Create a detailed implementation plan for the following task. Output ONLY the plan, do NOT implement anything.\n\n",
    ko: "다음 작업에 대한 상세 구현 계획을 작성하세요. 계획만 출력하고, 구현하지 마세요.\n\n",
    ja: "以下のタスクの詳細な実装計画を作成してください。計画のみ出力し、実装はしないでください。\n\n",
    zh: "请为以下任务制定详细的实施计划。仅输出计划，不要实现任何内容。\n\n",
  },
  qa: {
    en: "You are the QA tester. Review and test the changes made for the following task. The working directory contains the implementation. Run tests, verify correctness, and report PASS or FAIL with details.\n\n",
    ko: "당신은 QA 테스터입니다. 다음 작업의 변경 사항을 검토하고 테스트하세요. 작업 디렉토리에 구현이 포함되어 있습니다. 테스트를 실행하고 PASS 또는 FAIL로 보고하세요.\n\n",
    ja: "あなたはQAテスターです。以下のタスクの変更をレビューしテストしてください。作業ディレクトリに実装が含まれています。テストを実行し、PASSまたはFAILで詳細を報告してください。\n\n",
    zh: "你是QA测试人员。请审查并测试以下任务的更改。工作目录包含实现代码。运行测试，验证正确性，并报告PASS或FAIL及详细信息。\n\n",
  },
};

export function getPipelineStepPromptPrefix(departmentId: string, lang: string): string {
  const prefixes = STEP_PROMPT_PREFIXES[departmentId];
  if (!prefixes) return "";
  const langKey = lang === "ko" || lang === "ja" || lang === "zh" ? lang : "en";
  return prefixes[langKey as keyof typeof prefixes] ?? prefixes.en;
}

/**
 * Build a context block that summarizes previous pipeline step results.
 */
export function buildPipelineContextBlock(pipeline: PipelineMeta, lang: string): string {
  const entries = Object.entries(pipeline.step_results);
  if (entries.length === 0) return "";
  const header =
    lang === "ko"
      ? "이전 파이프라인 단계 결과"
      : lang === "ja"
        ? "前のパイプラインステップの結果"
        : lang === "zh"
          ? "之前的管道步骤结果"
          : "Previous Pipeline Step Results";
  const parts = entries.map(([dept, result]) => {
    const trimmed = result.length > 1500 ? result.slice(-1500) : result;
    return `### ${dept}\n${trimmed}`;
  });
  return `\n\n[${header}]\n${parts.join("\n\n")}`;
}

// ── Auto-Retry Queries ─────────────────────────────────────────────

export function hasAutoRetry(meta: WorkflowMeta): meta is WorkflowMeta & { auto_retry: AutoRetryMeta } {
  return !!meta.auto_retry && meta.auto_retry.enabled === true;
}

export function canRetry(autoRetry: AutoRetryMeta): boolean {
  return autoRetry.count < autoRetry.max;
}

// ── QA Failure: Step-back Logic ────────────────────────────────────

const QA_LIKE_DEPARTMENTS = new Set(["qa", "browser"]);
const MAX_QA_BOUNCES = 2;

/**
 * Check if a QA-like step failed and should bounce back to the previous (dev) step.
 * Returns the step index to bounce back to, or -1 if no bounce.
 */
export function resolveQaBounceStep(pipeline: PipelineMeta): number {
  const currentDept = pipeline.steps[pipeline.current_step];
  if (!QA_LIKE_DEPARTMENTS.has(currentDept)) return -1;
  if (pipeline.current_step <= 0) return -1;

  // Count how many times we've already bounced (step_results entries for same dept > 1)
  const bounceCount = Object.keys(pipeline.step_results).filter((key) =>
    key.startsWith(`${currentDept}_bounce_`),
  ).length;
  if (bounceCount >= MAX_QA_BOUNCES) return -1;

  return pipeline.current_step - 1;
}
