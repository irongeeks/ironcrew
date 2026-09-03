import { useMemo, useState } from "react";
import type { Task } from "../../types";
import { useI18n } from "../../i18n";
import { HIDEABLE_STATUSES, isHideableStatus, taskStatusLabel, type HideableStatus } from "./constants";

interface BulkHideModalProps {
  tasks: Task[];
  hiddenTaskIds: Set<string>;
  onClose: () => void;
  onApply: (statuses: HideableStatus[]) => void;
}

export default function BulkHideModal({ tasks, hiddenTaskIds, onClose, onApply }: BulkHideModalProps) {
  const { t } = useI18n();

  const availableCounts = useMemo(() => {
    const counts: Record<HideableStatus, number> = {
      done: 0,
      pending: 0,
      cancelled: 0,
    };
    for (const task of tasks) {
      if (!isHideableStatus(task.status) || hiddenTaskIds.has(task.id)) continue;
      counts[task.status] += 1;
    }
    return counts;
  }, [tasks, hiddenTaskIds]);

  const [selected, setSelected] = useState<Record<HideableStatus, boolean>>({
    done: availableCounts.done > 0,
    pending: availableCounts.pending > 0,
    cancelled: availableCounts.cancelled > 0,
  });

  const selectedStatuses = useMemo(
    () => HIDEABLE_STATUSES.filter((status) => selected[status] && availableCounts[status] > 0),
    [selected, availableCounts],
  );

  const hideTargetCount = useMemo(
    () => selectedStatuses.reduce((count, status) => count + availableCounts[status], 0),
    [selectedStatuses, availableCounts],
  );

  const statusRows = useMemo(
    () =>
      HIDEABLE_STATUSES.map((status) => ({
        status,
        label: taskStatusLabel(status, t),
        count: availableCounts[status],
      })),
    [availableCounts, t],
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        className="w-full max-w-sm rounded-2xl border p-5 shadow-2xl"
        style={{ borderColor: "var(--th-border)", background: "var(--th-bg-secondary)" }}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-bold" style={{ color: "var(--th-text-heading)" }}>
            {t({
              ko: "숨길 상태 선택",
              en: "Select statuses to hide",
              ja: "非表示にする状態を選択",
              zh: "Select statuses to hide",
              de: "Auszublendende Status auswählen",
            })}
          </h2>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 transition hover:text-white"
            style={{ color: "var(--th-text-secondary)" }}
            title={t({ ko: "닫기", en: "Close", ja: "閉じる", zh: "Close", de: "Schließen" })}
          >
            ✕
          </button>
        </div>

        <p className="mb-3 text-xs leading-relaxed" style={{ color: "var(--th-text-secondary)" }}>
          {t({
            ko: "완료/보류/취소 중 선택한 상태의 업무를 한 번에 숨깁니다.",
            en: "Hide all tasks in the selected done/pending/cancelled statuses at once.",
            ja: "選択した完了/保留/キャンセル状態のタスクを一括で非表示にします。",
            zh: "Hide all tasks in the selected done/pending/cancelled statuses at once.",
            de: "Alle Aufgaben mit den ausgewählten Statuswerten (Erledigt/Ausstehend/Abgebrochen) auf einmal ausblenden.",
          })}
        </p>

        <div className="space-y-2">
          {statusRows.map(({ status, label, count }) => (
            <label
              key={status}
              className={`flex cursor-pointer items-center justify-between rounded-lg border px-3 py-2 ${
                count > 0 ? "text-slate-200" : "cursor-not-allowed"
              }`}
              style={
                count > 0
                  ? { borderColor: "var(--th-border)", background: "var(--th-card-bg)" }
                  : {
                      borderColor: "var(--th-card-bg)",
                      background: "var(--th-bg-secondary)",
                      color: "var(--th-text-muted)",
                    }
              }
            >
              <span className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selected[status]}
                  disabled={count <= 0}
                  onChange={() => {
                    setSelected((prev) => ({ ...prev, [status]: !prev[status] }));
                  }}
                  className="h-3.5 w-3.5 rounded border-slate-500 text-blue-500 focus:ring-blue-500"
                  style={{ backgroundColor: "var(--th-bg-surface-hover)" }}
                />
                {label}
              </span>
              <span
                className="rounded-full px-2 py-0.5 text-[11px]"
                style={{ background: "var(--th-bg-surface-hover)", color: "var(--th-text-secondary)" }}
              >
                {count}
              </span>
            </label>
          ))}
        </div>

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg border px-3 py-1.5 text-xs transition hover:text-white"
            style={{ borderColor: "var(--th-border)", color: "var(--th-text-secondary)" }}
          >
            {t({ ko: "취소", en: "Cancel", ja: "キャンセル", zh: "Cancel", de: "Abbrechen" })}
          </button>
          <button
            onClick={() => onApply(selectedStatuses)}
            disabled={hideTargetCount <= 0}
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:text-slate-400"
            style={hideTargetCount <= 0 ? { background: "var(--th-bg-surface-hover)" } : undefined}
          >
            {t({ ko: "숨김 적용", en: "Apply hide", ja: "非表示適用", zh: "Apply hide", de: "Ausblenden anwenden" })} (
            {hideTargetCount})
          </button>
        </div>
      </div>
    </div>
  );
}
