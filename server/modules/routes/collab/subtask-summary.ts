import type { DbLike } from "../../../types/db-like.ts";
import type { Lang } from "../../../types/lang.ts";

type L10n = Record<Lang, string[]>;
type LocalizeFactory = (ko: string[], en: string[], ja?: string[], zh?: string[]) => L10n;
type PickLocalized = (pool: L10n, lang: Lang) => string;

export interface SubtaskRow {
  id: string;
  task_id: string;
  title: string;
  description: string | null;
  status: string;
  created_at: number;
  target_department_id: string | null;
  delegated_task_id: string | null;
  blocked_reason: string | null;
}

interface TaskSubtaskProgressSummary {
  total: number;
  done: number;
  remediationTotal: number;
  remediationDone: number;
  collaborationTotal: number;
  collaborationDone: number;
}

const REMEDIATION_SUBTASK_PREFIXES = [
  "[보완계획]",
  "[검토보완]",
  "[Plan Item]",
  "[Review Revision]",
  "[補完計画]",
  "[レビュー補完]",
  "[计划项]",
  "[评审整改]",
];

const COLLABORATION_SUBTASK_PREFIXES = ["[협업]", "[Collaboration]", "[協業]", "[协作]"];

interface InitializeSubtaskSummaryArgs {
  db: DbLike;
  l: LocalizeFactory;
  pickL: PickLocalized;
}

export function initializeSubtaskSummary({ db, l, pickL }: InitializeSubtaskSummaryArgs): {
  formatTaskSubtaskProgressSummary(taskId: string, lang: Lang): string;
  groupSubtasksByTargetDepartment(subtasks: SubtaskRow[]): SubtaskRow[][];
  orderSubtaskQueuesByDepartment(queues: SubtaskRow[][]): SubtaskRow[][];
} {
  function hasAnyPrefix(title: string, prefixes: string[]): boolean {
    const trimmed = title.trim();
    return prefixes.some((prefix) => trimmed.startsWith(prefix));
  }

  function getTaskSubtaskProgressSummary(taskId: string): TaskSubtaskProgressSummary {
    const rows = db.prepare("SELECT title, status FROM subtasks WHERE task_id = ?").all(taskId) as Array<{
      title: string;
      status: string;
    }>;

    const summary: TaskSubtaskProgressSummary = {
      total: rows.length,
      done: 0,
      remediationTotal: 0,
      remediationDone: 0,
      collaborationTotal: 0,
      collaborationDone: 0,
    };

    for (const row of rows) {
      const isDone = row.status === "done";
      if (isDone) summary.done += 1;

      const isRemediation = hasAnyPrefix(row.title, REMEDIATION_SUBTASK_PREFIXES);
      if (isRemediation) {
        summary.remediationTotal += 1;
        if (isDone) summary.remediationDone += 1;
      }

      const isCollaboration = hasAnyPrefix(row.title, COLLABORATION_SUBTASK_PREFIXES);
      if (isCollaboration) {
        summary.collaborationTotal += 1;
        if (isDone) summary.collaborationDone += 1;
      }
    }

    return summary;
  }

  function formatTaskSubtaskProgressSummary(taskId: string, lang: Lang): string {
    const summary = getTaskSubtaskProgressSummary(taskId);
    if (summary.total === 0) return "";

    return pickL(
      l(
        [
          `- 전체: ${summary.done}/${summary.total} 완료`,
          `- 보완사항: ${summary.remediationDone}/${summary.remediationTotal} 완료`,
          `- 협업사항: ${summary.collaborationDone}/${summary.collaborationTotal} 완료`,
        ],
        [
          `- Overall: ${summary.done}/${summary.total} done`,
          `- Remediation: ${summary.remediationDone}/${summary.remediationTotal} done`,
          `- Collaboration: ${summary.collaborationDone}/${summary.collaborationTotal} done`,
        ],
        [
          `- 全体: ${summary.done}/${summary.total} 完了`,
          `- 補完事項: ${summary.remediationDone}/${summary.remediationTotal} 完了`,
          `- 協業事項: ${summary.collaborationDone}/${summary.collaborationTotal} 完了`,
        ],
        [
          `- 全部: ${summary.done}/${summary.total} 完成`,
          `- 整改事项: ${summary.remediationDone}/${summary.remediationTotal} 完成`,
          `- 协作事项: ${summary.collaborationDone}/${summary.collaborationTotal} 完成`,
        ],
      ),
      lang,
    );
  }

  function groupSubtasksByTargetDepartment(subtasks: SubtaskRow[]): SubtaskRow[][] {
    const grouped = new Map<string, SubtaskRow[]>();
    for (const subtask of subtasks) {
      const key = subtask.target_department_id ?? `unknown:${subtask.id}`;
      const bucket = grouped.get(key) ?? [];
      bucket.push(subtask);
      grouped.set(key, bucket);
    }
    return [...grouped.values()];
  }

  function getSubtaskDeptExecutionPriority(deptId: string | null): number {
    if (!deptId) return 999;
    const explicitOrder: Record<string, number> = {
      planning: 0,
      dev: 1,
      design: 2,
      qa: 3,
    };
    if (deptId in explicitOrder) return explicitOrder[deptId];
    const row = db.prepare("SELECT sort_order FROM departments WHERE id = ?").get(deptId) as
      | { sort_order: number }
      | undefined;
    return row?.sort_order ?? 999;
  }

  function orderSubtaskQueuesByDepartment(queues: SubtaskRow[][]): SubtaskRow[][] {
    return [...queues].sort((a, b) => {
      const deptA = a[0]?.target_department_id ?? null;
      const deptB = b[0]?.target_department_id ?? null;
      const priorityA = getSubtaskDeptExecutionPriority(deptA);
      const priorityB = getSubtaskDeptExecutionPriority(deptB);
      if (priorityA !== priorityB) return priorityA - priorityB;
      const createdAtA = a[0]?.created_at ?? 0;
      const createdAtB = b[0]?.created_at ?? 0;
      return createdAtA - createdAtB;
    });
  }

  return {
    formatTaskSubtaskProgressSummary,
    groupSubtasksByTargetDepartment,
    orderSubtaskQueuesByDepartment,
  };
}
