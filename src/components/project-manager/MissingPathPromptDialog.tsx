import type { MissingPathPrompt, ProjectI18nTranslate } from "./types";

interface MissingPathPromptDialogProps {
  prompt: MissingPathPrompt | null;
  t: ProjectI18nTranslate;
  saving: boolean;
  onCancel: () => void;
  onConfirmCreate: () => void;
}

export default function MissingPathPromptDialog({
  prompt,
  t,
  saving,
  onCancel,
  onConfirmCreate,
}: MissingPathPromptDialogProps) {
  if (!prompt) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4" onClick={onCancel}>
      <div
        className="w-full max-w-lg overflow-hidden rounded-xl border shadow-2xl"
        style={{ borderColor: "var(--th-border)", background: "var(--th-card-bg)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b px-4 py-3" style={{ borderColor: "var(--th-border)" }}>
          <h3 className="text-sm font-semibold" style={{ color: "var(--th-text-heading)" }}>
            {t({ en: "Confirm Project Path", de: "Projektpfad bestätigen" })}
          </h3>
        </div>
        <div className="space-y-2 px-4 py-4">
          <p className="text-sm text-[var(--th-text-primary)]">
            {t({ en: "This path does not exist. Create it now?", de: "Dieser Pfad existiert nicht. Jetzt erstellen?" })}
          </p>
          <p
            className="break-all rounded-md border px-2.5 py-2 text-xs text-[var(--th-text-primary)]"
            style={{ borderColor: "var(--th-border)", background: "var(--th-bg-surface-hover)" }}
          >
            {prompt.normalizedPath}
          </p>
          {prompt.nearestExistingParent && (
            <p className="text-xs" style={{ color: "var(--th-text-secondary)" }}>
              {t({
                ko: `기준 폴더: ${prompt.nearestExistingParent}`,
                en: `Base folder: ${prompt.nearestExistingParent}`,
                ja: `基準フォルダ: ${prompt.nearestExistingParent}`,
                zh: `Base folder: ${prompt.nearestExistingParent}`,
                de: `Basisordner: ${prompt.nearestExistingParent}`,
              })}
            </p>
          )}
          {!prompt.canCreate && (
            <p className="text-xs text-amber-300">
              {t({
                en: "This path is not creatable with current permissions. Choose another path.",
                de: "Dieser Pfad kann mit den aktuellen Berechtigungen nicht erstellt werden. Bitte anderen Pfad wählen.",
              })}
            </p>
          )}
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
            disabled={!prompt.canCreate || saving}
            onClick={onConfirmCreate}
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t({ en: "Yes", de: "Ja" })}
          </button>
        </div>
      </div>
    </div>
  );
}
