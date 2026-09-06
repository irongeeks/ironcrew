import { timeAgo } from "../constants";
import type { CreateTaskModalOverlaysProps } from "./overlay-types";

export default function CreateTaskModalOverlays({
  t,
  localeTag,
  restorePromptOpen,
  selectedRestoreDraft,
  restoreCandidates,
  selectedRestoreDraftId,
  formatDraftTimestamp,
  submitWithoutProjectPromptOpen,
  missingPathPrompt,
  submitBusy,
  manualPathPickerOpen,
  manualPathLoading,
  manualPathCurrent,
  manualPathParent,
  manualPathEntries,
  manualPathTruncated,
  manualPathError,
  draftModalOpen,
  drafts,
  onSelectRestoreDraft,
  onCloseRestorePrompt,
  onLoadSelectedRestoreDraft,
  onCloseSubmitWithoutProjectPrompt,
  onConfirmSubmitWithoutProject,
  onCloseMissingPathPrompt,
  onConfirmCreateMissingPath,
  onCloseManualPathPicker,
  onManualPathGoUp,
  onManualPathRefresh,
  onOpenManualPathEntry,
  onSelectManualCurrentPath,
  onCloseDraftModal,
  onLoadDraft,
  onDeleteDraft,
  onClearDrafts,
}: CreateTaskModalOverlaysProps) {
  return (
    <>
      {restorePromptOpen && selectedRestoreDraft && (
        <div
          className="fixed inset-0 z-[58] flex items-center justify-center bg-black/65 p-4"
          onClick={onCloseRestorePrompt}
        >
          <div
            className="w-full max-w-md overflow-hidden rounded-xl border shadow-2xl"
            style={{ borderColor: "var(--th-border)", background: "var(--th-bg-secondary)" }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="border-b px-4 py-3" style={{ borderColor: "var(--th-border)" }}>
              <h3 className="text-sm font-semibold" style={{ color: "var(--th-text-heading)" }}>
                {t({ en: "Restore Draft", de: "Entwurf wiederherstellen" })}
              </h3>
            </div>
            <div className="space-y-2 px-4 py-4">
              <p className="text-sm" style={{ color: "var(--th-text-primary)" }}>
                {t({
                  en: "There is previously entered data. Would you like to load it?",
                  de: "Es gibt zuvor eingegebene Daten. Möchten Sie diese laden?",
                })}
              </p>
              <p className="text-xs" style={{ color: "var(--th-text-secondary)" }}>
                {t({ en: "Recent drafts (up to 3)", de: "Neueste Entwürfe (max. 3)" })}
              </p>
              <div className="space-y-2">
                {restoreCandidates.map((draft) => {
                  const isSelected = selectedRestoreDraftId === draft.id;
                  return (
                    <button
                      key={draft.id}
                      type="button"
                      onClick={() => onSelectRestoreDraft(draft.id)}
                      className={`w-full rounded-lg border px-3 py-2 text-left transition ${
                        isSelected ? "border-blue-500 bg-blue-500/15" : ""
                      }`}
                      style={
                        isSelected ? undefined : { borderColor: "var(--th-border)", background: "var(--th-card-bg)" }
                      }
                    >
                      <p className="truncate text-sm font-semibold text-slate-100">
                        {draft.title || t({ en: "(Untitled)", de: "(Kein Titel)" })}
                      </p>
                      <p className="mt-0.5 text-xs" style={{ color: "var(--th-text-secondary)" }}>
                        {formatDraftTimestamp(draft.updatedAt)} · {timeAgo(draft.updatedAt, localeTag)}
                      </p>
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t px-4 py-3" style={{ borderColor: "var(--th-border)" }}>
              <button
                type="button"
                onClick={onCloseRestorePrompt}
                className="rounded-md border px-3 py-1.5 text-xs font-semibold transition"
                style={{ borderColor: "var(--th-border-strong)", color: "var(--th-text-primary)" }}
              >
                {t({ en: "Start Fresh", de: "Neu beginnen" })}
              </button>
              <button
                type="button"
                onClick={onLoadSelectedRestoreDraft}
                className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-blue-500"
              >
                {t({ en: "Load", de: "Laden" })}
              </button>
            </div>
          </div>
        </div>
      )}

      {submitWithoutProjectPromptOpen && (
        <div
          className="fixed inset-0 z-[59] flex items-center justify-center bg-black/70 p-4"
          onClick={onCloseSubmitWithoutProjectPrompt}
        >
          <div
            className="w-full max-w-md overflow-hidden rounded-xl border shadow-2xl"
            style={{ borderColor: "var(--th-border)", background: "var(--th-bg-secondary)" }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="border-b px-4 py-3" style={{ borderColor: "var(--th-border)" }}>
              <h3 className="text-sm font-semibold" style={{ color: "var(--th-text-heading)" }}>
                {t({ en: "Create Without Project", de: "Ohne Projekt erstellen" })}
              </h3>
            </div>
            <div className="space-y-2 px-4 py-4">
              <p className="text-sm" style={{ color: "var(--th-text-primary)" }}>
                {t({
                  en: "Create this task without a project link?",
                  de: "Diese Aufgabe ohne Projektverknüpfung erstellen?",
                })}
              </p>
              <p className="text-xs" style={{ color: "var(--th-text-secondary)" }}>
                {t({
                  en: "It will not appear in project history.",
                  de: "Sie wird nicht in der Projekthistorie erscheinen.",
                })}
              </p>
            </div>
            <div className="flex justify-end gap-2 border-t px-4 py-3" style={{ borderColor: "var(--th-border)" }}>
              <button
                type="button"
                onClick={onCloseSubmitWithoutProjectPrompt}
                className="rounded-md border px-3 py-1.5 text-xs font-semibold transition"
                style={{ borderColor: "var(--th-border-strong)", color: "var(--th-text-primary)" }}
              >
                {t({ en: "Cancel", de: "Abbrechen" })}
              </button>
              <button
                type="button"
                onClick={onConfirmSubmitWithoutProject}
                className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-blue-500"
              >
                {t({ en: "Continue", de: "Fortfahren" })}
              </button>
            </div>
          </div>
        </div>
      )}

      {missingPathPrompt && (
        <div
          className="fixed inset-0 z-[59] flex items-center justify-center bg-black/70 p-4"
          onClick={onCloseMissingPathPrompt}
        >
          <div
            className="w-full max-w-md overflow-hidden rounded-xl border shadow-2xl"
            style={{ borderColor: "var(--th-border)", background: "var(--th-bg-secondary)" }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="border-b px-4 py-3" style={{ borderColor: "var(--th-border)" }}>
              <h3 className="text-sm font-semibold" style={{ color: "var(--th-text-heading)" }}>
                {t({ en: "Confirm Project Path", de: "Projektpfad bestätigen" })}
              </h3>
            </div>
            <div className="space-y-2 px-4 py-4">
              <p className="text-sm" style={{ color: "var(--th-text-primary)" }}>
                {t({
                  en: "This path does not exist. Create it now?",
                  de: "Dieser Pfad existiert nicht. Jetzt erstellen?",
                })}
              </p>
              <p
                className="break-all rounded-md border px-2.5 py-2 text-xs"
                style={{
                  borderColor: "var(--th-border)",
                  background: "var(--th-card-bg)",
                  color: "var(--th-text-primary)",
                }}
              >
                {missingPathPrompt.normalizedPath}
              </p>
              {missingPathPrompt.nearestExistingParent && (
                <p className="text-xs" style={{ color: "var(--th-text-secondary)" }}>
                  {t({
                    ko: `기준 폴더: ${missingPathPrompt.nearestExistingParent}`,
                    en: `Base folder: ${missingPathPrompt.nearestExistingParent}`,
                    ja: `基準フォルダ: ${missingPathPrompt.nearestExistingParent}`,
                    zh: `Base folder: ${missingPathPrompt.nearestExistingParent}`,
                    de: `Basisordner: ${missingPathPrompt.nearestExistingParent}`,
                  })}
                </p>
              )}
              {!missingPathPrompt.canCreate && (
                <p className="text-xs text-amber-300">
                  {t({
                    en: "This path is not creatable with current permissions. Choose another path.",
                    de: "Dieser Pfad kann mit den aktuellen Berechtigungen nicht erstellt werden. Wählen Sie einen anderen Pfad.",
                  })}
                </p>
              )}
            </div>
            <div className="flex justify-end gap-2 border-t px-4 py-3" style={{ borderColor: "var(--th-border)" }}>
              <button
                type="button"
                onClick={onCloseMissingPathPrompt}
                className="rounded-md border px-3 py-1.5 text-xs font-semibold transition"
                style={{ borderColor: "var(--th-border-strong)", color: "var(--th-text-primary)" }}
              >
                {t({ en: "Cancel", de: "Abbrechen" })}
              </button>
              <button
                type="button"
                disabled={!missingPathPrompt.canCreate || submitBusy}
                onClick={onConfirmCreateMissingPath}
                className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {t({ en: "Yes", de: "Ja" })}
              </button>
            </div>
          </div>
        </div>
      )}

      {manualPathPickerOpen && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4"
          onClick={onCloseManualPathPicker}
        >
          <div
            className="w-full max-w-2xl overflow-hidden rounded-xl border shadow-2xl"
            style={{ borderColor: "var(--th-border)", background: "var(--th-bg-secondary)" }}
            onClick={(event) => event.stopPropagation()}
          >
            <div
              className="flex items-center justify-between border-b px-4 py-3"
              style={{ borderColor: "var(--th-border)" }}
            >
              <h3 className="text-sm font-semibold" style={{ color: "var(--th-text-heading)" }}>
                {t({ en: "In-App Folder Browser", de: "Ordner-Browser" })}
              </h3>
              <button
                type="button"
                onClick={onCloseManualPathPicker}
                className="rounded-md px-2 py-1 text-xs transition hover:text-white"
                style={{ color: "var(--th-text-secondary)" }}
              >
                ✕
              </button>
            </div>
            <div className="space-y-3 px-4 py-4">
              <div
                className="rounded-lg border px-3 py-2"
                style={{ borderColor: "var(--th-border)", background: "var(--th-card-bg)" }}
              >
                <p className="text-[11px]" style={{ color: "var(--th-text-secondary)" }}>
                  {t({ en: "Current Location", de: "Aktueller Ort" })}
                </p>
                <p className="break-all text-xs" style={{ color: "var(--th-text-primary)" }}>
                  {manualPathCurrent || "-"}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={!manualPathParent || manualPathLoading}
                  onClick={onManualPathGoUp}
                  className="rounded-md border px-2.5 py-1 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-40"
                  style={{ borderColor: "var(--th-border-strong)", color: "var(--th-text-primary)" }}
                >
                  {t({ en: "Up", de: "Übergeordnet" })}
                </button>
                <button
                  type="button"
                  disabled={manualPathLoading}
                  onClick={onManualPathRefresh}
                  className="rounded-md border px-2.5 py-1 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-40"
                  style={{ borderColor: "var(--th-border-strong)", color: "var(--th-text-primary)" }}
                >
                  {t({ en: "Refresh", de: "Aktualisieren" })}
                </button>
              </div>
              <div
                className="max-h-[45dvh] overflow-y-auto rounded-lg border"
                style={{ borderColor: "var(--th-border)", background: "var(--th-card-bg)" }}
              >
                {manualPathLoading ? (
                  <p className="px-3 py-2 text-xs" style={{ color: "var(--th-text-secondary)" }}>
                    {t({ en: "Loading directories...", de: "Verzeichnisse werden geladen..." })}
                  </p>
                ) : manualPathError ? (
                  <p className="px-3 py-2 text-xs text-rose-300">{manualPathError}</p>
                ) : manualPathEntries.length === 0 ? (
                  <p className="px-3 py-2 text-xs" style={{ color: "var(--th-text-secondary)" }}>
                    {t({ en: "No selectable subdirectories.", de: "Keine auswählbaren Unterverzeichnisse." })}
                  </p>
                ) : (
                  manualPathEntries.map((entry) => (
                    <button
                      key={entry.path}
                      type="button"
                      onClick={() => onOpenManualPathEntry(entry.path)}
                      className="w-full border-b px-3 py-2 text-left transition"
                      style={{ borderColor: "var(--th-border)" }}
                    >
                      <p className="text-xs font-semibold text-slate-100">{entry.name}</p>
                      <p className="truncate text-[11px]" style={{ color: "var(--th-text-secondary)" }}>
                        {entry.path}
                      </p>
                    </button>
                  ))
                )}
              </div>
              {manualPathTruncated && (
                <p className="text-[11px]" style={{ color: "var(--th-text-secondary)" }}>
                  {t({
                    en: "Only the first 300 directories are shown.",
                    de: "Es werden nur die ersten 300 Verzeichnisse angezeigt.",
                  })}
                </p>
              )}
            </div>
            <div className="flex justify-end gap-2 border-t px-4 py-3" style={{ borderColor: "var(--th-border)" }}>
              <button
                type="button"
                onClick={onCloseManualPathPicker}
                className="rounded-md border px-3 py-1.5 text-xs font-semibold transition"
                style={{ borderColor: "var(--th-border-strong)", color: "var(--th-text-primary)" }}
              >
                {t({ en: "Cancel", de: "Abbrechen" })}
              </button>
              <button
                type="button"
                disabled={!manualPathCurrent}
                onClick={onSelectManualCurrentPath}
                className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {t({ en: "Select Current Folder", de: "Aktuellen Ordner auswählen" })}
              </button>
            </div>
          </div>
        </div>
      )}

      {draftModalOpen && (
        <div
          className="fixed inset-0 z-[61] flex items-center justify-center bg-black/70 p-4"
          onClick={onCloseDraftModal}
        >
          <div
            className="w-full max-w-xl overflow-hidden rounded-xl border shadow-2xl"
            style={{ borderColor: "var(--th-border)", background: "var(--th-bg-secondary)" }}
            onClick={(event) => event.stopPropagation()}
          >
            <div
              className="flex items-center justify-between border-b px-4 py-3"
              style={{ borderColor: "var(--th-border)" }}
            >
              <h3 className="text-sm font-semibold" style={{ color: "var(--th-text-heading)" }}>
                {t({ en: "Temporary Drafts", de: "Temporäre Entwürfe" })}
              </h3>
              <button
                type="button"
                onClick={onCloseDraftModal}
                className="rounded-md px-2 py-1 text-xs transition hover:text-white"
                style={{ color: "var(--th-text-secondary)" }}
                title={t({ en: "Close", de: "Schließen" })}
              >
                ✕
              </button>
            </div>

            <div className="max-h-[55dvh] space-y-2 overflow-y-auto px-4 py-3">
              {drafts.length === 0 ? (
                <div
                  className="rounded-lg border px-3 py-4 text-center text-sm"
                  style={{
                    borderColor: "var(--th-border)",
                    background: "var(--th-card-bg)",
                    color: "var(--th-text-secondary)",
                  }}
                >
                  {t({ en: "No temporary drafts saved.", de: "Keine temporären Entwürfe gespeichert." })}
                </div>
              ) : (
                drafts.map((draft) => (
                  <div
                    key={draft.id}
                    className="rounded-lg border p-3"
                    style={{ borderColor: "var(--th-border)", background: "var(--th-card-bg)" }}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-slate-100">
                          {draft.title || t({ en: "(Untitled)", de: "(Kein Titel)" })}
                        </p>
                        <p className="mt-0.5 text-xs" style={{ color: "var(--th-text-secondary)" }}>
                          {formatDraftTimestamp(draft.updatedAt)} · {timeAgo(draft.updatedAt, localeTag)}
                        </p>
                        {draft.description.trim() && (
                          <p className="mt-1 line-clamp-2 text-xs" style={{ color: "var(--th-text-secondary)" }}>
                            {draft.description}
                          </p>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          onClick={() => onLoadDraft(draft)}
                          className="rounded-md bg-blue-600 px-2.5 py-1 text-xs font-semibold text-white transition hover:bg-blue-500"
                        >
                          {t({ en: "Load", de: "Laden" })}
                        </button>
                        <button
                          type="button"
                          onClick={() => onDeleteDraft(draft.id)}
                          className="rounded-md border border-red-500/70 px-2.5 py-1 text-xs font-semibold text-red-300 transition hover:bg-red-500/10"
                        >
                          {t({ en: "Delete", de: "Löschen" })}
                        </button>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="flex justify-end border-t px-4 py-3" style={{ borderColor: "var(--th-border)" }}>
              <button
                type="button"
                onClick={onClearDrafts}
                disabled={drafts.length === 0}
                className="rounded-md border px-3 py-1.5 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-40"
                style={{ borderColor: "var(--th-border-strong)", color: "var(--th-text-primary)" }}
              >
                {t({ en: "Delete All", de: "Alle löschen" })}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
