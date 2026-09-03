import type { ManualAssignmentWarning, ProjectI18nTranslate, ProjectManualSelectionStats } from "./types";

interface ManualAssignmentWarningDialogProps {
  warning: ManualAssignmentWarning | null;
  stats: ProjectManualSelectionStats;
  t: ProjectI18nTranslate;
  onCancel: () => void;
  onConfirm: (warning: ManualAssignmentWarning) => void;
}

export default function ManualAssignmentWarningDialog({
  warning,
  stats,
  t,
  onCancel,
  onConfirm,
}: ManualAssignmentWarningDialogProps) {
  if (!warning) return null;

  return (
    <div className="fixed inset-0 z-[61] flex items-center justify-center bg-black/70 p-4" onClick={onCancel}>
      <div
        className="w-full max-w-lg overflow-hidden rounded-xl border border-amber-500/40 shadow-2xl"
        style={{ background: "var(--th-card-bg)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-amber-500/30 px-4 py-3">
          <h3 className="text-sm font-semibold text-amber-200">
            {t({
              ko: "수동 배정 확인",
              en: "Manual Assignment Check",
              ja: "手動割り当て確認",
              zh: "Manual Assignment Check",
              de: "Manuelle Zuweisung prüfen",
            })}
          </h3>
        </div>
        <div className="space-y-2 px-4 py-4">
          <p className="text-sm" style={{ color: "var(--th-text-primary)" }}>
            {warning.reason === "no_agents"
              ? t({
                  ko: "직원이 선택되지 않았습니다. 이 상태로 저장하면 수동 모드 안전장치에 따라 팀장이 직접(단독) 실행할 수 있습니다. 계속 저장할까요?",
                  en: "No agents are selected. If you save now, the manual-mode safeguard may let team leaders execute tasks directly. Continue?",
                  ja: "エージェントが選択されていません。このまま保存すると実行時にチームリーダーが直接対応する可能性があります。続行しますか？",
                  zh: "No agents are selected. If you save now, the manual-mode safeguard may let team leaders execute tasks directly. Continue?",
                  de: "Keine Agenten ausgewählt. Beim Speichern können Teamleiter Aufgaben direkt ausführen. Fortfahren?",
                })
              : t({
                  ko: "팀장만 선택되어 있습니다. 하위 직원이 없으므로 수동 모드 안전장치에 따라 팀장이 직접(단독) 실행할 수 있습니다. 계속 저장할까요?",
                  en: "Only team leaders are selected. Without subordinates, the manual-mode safeguard may let team leaders execute tasks directly. Continue?",
                  ja: "チームリーダーのみ選択されています。サブ担当がいない場合、実行時にチームリーダーが直接対応する可能性があります。続行しますか？",
                  zh: "Only team leaders are selected. Without subordinates, the manual-mode safeguard may let team leaders execute tasks directly. Continue?",
                  de: "Nur Teamleiter ausgewählt. Ohne Mitarbeiter können Teamleiter Aufgaben direkt ausführen. Fortfahren?",
                })}
          </p>
          <div
            className="rounded-md border px-3 py-2 text-[11px]"
            style={{
              borderColor: "var(--th-border)",
              background: "var(--th-card-bg)",
              color: "var(--th-text-secondary)",
            }}
          >
            <p>
              {t({
                ko: "선택 요약",
                en: "Selection Summary",
                ja: "選択サマリー",
                zh: "Selection Summary",
                de: "Auswahlzusammenfassung",
              })}
              : {stats.total}
            </p>
            <p>
              {t({ ko: "팀장", en: "Leaders", ja: "リーダー", zh: "Leaders", de: "Teamleiter" })}: {stats.leaders} ·{" "}
              {t({ ko: "하위 직원", en: "Subordinates", ja: "サブ担当", zh: "Subordinates", de: "Mitarbeiter" })}:{" "}
              {stats.subordinates}
            </p>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t px-4 py-3" style={{ borderColor: "var(--th-border)" }}>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border px-3 py-1.5 text-xs font-semibold text-[var(--th-text-primary)] transition hover:bg-[var(--th-bg-surface-hover)]"
            style={{ borderColor: "var(--th-border-strong)" }}
          >
            {t({ ko: "취소", en: "Cancel", ja: "キャンセル", zh: "Cancel", de: "Abbrechen" })}
          </button>
          <button
            type="button"
            onClick={() => onConfirm(warning)}
            className="rounded-md bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-amber-500"
          >
            {t({ ko: "계속 저장", en: "Save Anyway", ja: "そのまま保存", zh: "Save Anyway", de: "Trotzdem speichern" })}
          </button>
        </div>
      </div>
    </div>
  );
}
