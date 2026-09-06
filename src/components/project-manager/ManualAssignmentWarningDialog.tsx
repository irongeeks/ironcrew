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
            {t({ en: "Manual Assignment Check", de: "Manuelle Zuweisung prüfen" })}
          </h3>
        </div>
        <div className="space-y-2 px-4 py-4">
          <p className="text-sm" style={{ color: "var(--th-text-primary)" }}>
            {warning.reason === "no_agents"
              ? t({
                  en: "No agents are selected. If you save now, the manual-mode safeguard may let team leaders execute tasks directly. Continue?",
                  de: "Keine Agenten ausgewählt. Beim Speichern können Teamleiter Aufgaben direkt ausführen. Fortfahren?",
                })
              : t({
                  en: "Only team leaders are selected. Without subordinates, the manual-mode safeguard may let team leaders execute tasks directly. Continue?",
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
              {t({ en: "Selection Summary", de: "Auswahlzusammenfassung" })}: {stats.total}
            </p>
            <p>
              {t({ en: "Leaders", de: "Teamleiter" })}: {stats.leaders} · {t({ en: "Subordinates", de: "Mitarbeiter" })}
              : {stats.subordinates}
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
            {t({ en: "Cancel", de: "Abbrechen" })}
          </button>
          <button
            type="button"
            onClick={() => onConfirm(warning)}
            className="rounded-md bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-amber-500"
          >
            {t({ en: "Save Anyway", de: "Trotzdem speichern" })}
          </button>
        </div>
      </div>
    </div>
  );
}
