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
                {t({
                  ko: "임시 데이터 복구",
                  en: "Restore Draft",
                  ja: "下書き復元",
                  zh: "Restore Draft",
                  de: "Entwurf wiederherstellen",
                })}
              </h3>
            </div>
            <div className="space-y-2 px-4 py-4">
              <p className="text-sm" style={{ color: "var(--th-text-primary)" }}>
                {t({
                  ko: "기존에 입력하던 데이터가 있습니다. 불러오시겠습니까?",
                  en: "There is previously entered data. Would you like to load it?",
                  ja: "以前入力していたデータがあります。読み込みますか？",
                  zh: "There is previously entered data. Would you like to load it?",
                  de: "Es gibt zuvor eingegebene Daten. Möchten Sie diese laden?",
                })}
              </p>
              <p className="text-xs" style={{ color: "var(--th-text-secondary)" }}>
                {t({
                  ko: "최근 임시 항목 (최대 3개)",
                  en: "Recent drafts (up to 3)",
                  ja: "最近の下書き（最大3件）",
                  zh: "Recent drafts (up to 3)",
                  de: "Neueste Entwürfe (max. 3)",
                })}
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
                        {draft.title ||
                          t({
                            ko: "(제목 없음)",
                            en: "(Untitled)",
                            ja: "(無題)",
                            zh: "(Untitled)",
                            de: "(Kein Titel)",
                          })}
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
                {t({ ko: "새로 작성", en: "Start Fresh", ja: "新規作成", zh: "Start Fresh", de: "Neu beginnen" })}
              </button>
              <button
                type="button"
                onClick={onLoadSelectedRestoreDraft}
                className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-blue-500"
              >
                {t({ ko: "불러오기", en: "Load", ja: "読み込み", zh: "Load", de: "Laden" })}
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
                {t({
                  ko: "프로젝트 연결 없이 생성",
                  en: "Create Without Project",
                  ja: "プロジェクト未連携で作成",
                  zh: "Create Without Project",
                  de: "Ohne Projekt erstellen",
                })}
              </h3>
            </div>
            <div className="space-y-2 px-4 py-4">
              <p className="text-sm" style={{ color: "var(--th-text-primary)" }}>
                {t({
                  ko: "프로젝트 연결 없이 업무를 생성하시겠습니까?",
                  en: "Create this task without a project link?",
                  ja: "プロジェクト未連携でタスクを作成しますか？",
                  zh: "Create this task without a project link?",
                  de: "Diese Aufgabe ohne Projektverknüpfung erstellen?",
                })}
              </p>
              <p className="text-xs" style={{ color: "var(--th-text-secondary)" }}>
                {t({
                  ko: "이 경우 프로젝트 이력에는 집계되지 않습니다.",
                  en: "It will not appear in project history.",
                  ja: "この場合、プロジェクト履歴には集計されません。",
                  zh: "It will not appear in project history.",
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
                {t({ ko: "취소", en: "Cancel", ja: "キャンセル", zh: "Cancel", de: "Abbrechen" })}
              </button>
              <button
                type="button"
                onClick={onConfirmSubmitWithoutProject}
                className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-blue-500"
              >
                {t({ ko: "계속", en: "Continue", ja: "続行", zh: "Continue", de: "Fortfahren" })}
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
                {t({
                  ko: "프로젝트 경로 확인",
                  en: "Confirm Project Path",
                  ja: "プロジェクトパス確認",
                  zh: "Confirm Project Path",
                  de: "Projektpfad bestätigen",
                })}
              </h3>
            </div>
            <div className="space-y-2 px-4 py-4">
              <p className="text-sm" style={{ color: "var(--th-text-primary)" }}>
                {t({
                  ko: "해당 경로가 없습니다. 추가하시겠습니까?",
                  en: "This path does not exist. Create it now?",
                  ja: "このパスは存在しません。作成しますか？",
                  zh: "This path does not exist. Create it now?",
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
                    ko: "현재 권한으로 해당 경로를 생성할 수 없습니다. 다른 경로를 선택해주세요.",
                    en: "This path is not creatable with current permissions. Choose another path.",
                    ja: "現在の権限ではこのパスを作成できません。別のパスを指定してください。",
                    zh: "This path is not creatable with current permissions. Choose another path.",
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
                {t({ ko: "취소", en: "Cancel", ja: "キャンセル", zh: "Cancel", de: "Abbrechen" })}
              </button>
              <button
                type="button"
                disabled={!missingPathPrompt.canCreate || submitBusy}
                onClick={onConfirmCreateMissingPath}
                className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {t({ ko: "예", en: "Yes", ja: "はい", zh: "Yes", de: "Ja" })}
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
                {t({
                  ko: "앱 내 폴더 탐색",
                  en: "In-App Folder Browser",
                  ja: "アプリ内フォルダ閲覧",
                  zh: "In-App Folder Browser",
                  de: "Ordner-Browser",
                })}
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
                  {t({
                    ko: "현재 위치",
                    en: "Current Location",
                    ja: "現在位置",
                    zh: "Current Location",
                    de: "Aktueller Ort",
                  })}
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
                  {t({ ko: "상위 폴더", en: "Up", ja: "上位フォルダ", zh: "Up", de: "Übergeordnet" })}
                </button>
                <button
                  type="button"
                  disabled={manualPathLoading}
                  onClick={onManualPathRefresh}
                  className="rounded-md border px-2.5 py-1 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-40"
                  style={{ borderColor: "var(--th-border-strong)", color: "var(--th-text-primary)" }}
                >
                  {t({ ko: "새로고침", en: "Refresh", ja: "更新", zh: "Refresh", de: "Aktualisieren" })}
                </button>
              </div>
              <div
                className="max-h-[45dvh] overflow-y-auto rounded-lg border"
                style={{ borderColor: "var(--th-border)", background: "var(--th-card-bg)" }}
              >
                {manualPathLoading ? (
                  <p className="px-3 py-2 text-xs" style={{ color: "var(--th-text-secondary)" }}>
                    {t({
                      ko: "폴더 목록을 불러오는 중...",
                      en: "Loading directories...",
                      ja: "フォルダ一覧を読み込み中...",
                      zh: "Loading directories...",
                      de: "Verzeichnisse werden geladen...",
                    })}
                  </p>
                ) : manualPathError ? (
                  <p className="px-3 py-2 text-xs text-rose-300">{manualPathError}</p>
                ) : manualPathEntries.length === 0 ? (
                  <p className="px-3 py-2 text-xs" style={{ color: "var(--th-text-secondary)" }}>
                    {t({
                      ko: "선택 가능한 하위 폴더가 없습니다.",
                      en: "No selectable subdirectories.",
                      ja: "選択可能なサブディレクトリがありません。",
                      zh: "No selectable subdirectories.",
                      de: "Keine auswählbaren Unterverzeichnisse.",
                    })}
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
                    ko: "항목이 많아 상위 300개 폴더만 표시했습니다.",
                    en: "Only the first 300 directories are shown.",
                    ja: "項目数が多いため先頭300件のみ表示しています。",
                    zh: "Only the first 300 directories are shown.",
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
                {t({ ko: "취소", en: "Cancel", ja: "キャンセル", zh: "Cancel", de: "Abbrechen" })}
              </button>
              <button
                type="button"
                disabled={!manualPathCurrent}
                onClick={onSelectManualCurrentPath}
                className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {t({
                  ko: "현재 폴더 선택",
                  en: "Select Current Folder",
                  ja: "現在フォルダを選択",
                  zh: "Select Current Folder",
                  de: "Aktuellen Ordner auswählen",
                })}
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
                {t({
                  ko: "임시 저장 목록",
                  en: "Temporary Drafts",
                  ja: "一時保存一覧",
                  zh: "Temporary Drafts",
                  de: "Temporäre Entwürfe",
                })}
              </h3>
              <button
                type="button"
                onClick={onCloseDraftModal}
                className="rounded-md px-2 py-1 text-xs transition hover:text-white"
                style={{ color: "var(--th-text-secondary)" }}
                title={t({ ko: "닫기", en: "Close", ja: "閉じる", zh: "Close", de: "Schließen" })}
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
                  {t({
                    ko: "저장된 임시 항목이 없습니다.",
                    en: "No temporary drafts saved.",
                    ja: "保存された一時項目はありません。",
                    zh: "No temporary drafts saved.",
                    de: "Keine temporären Entwürfe gespeichert.",
                  })}
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
                          {draft.title ||
                            t({
                              ko: "(제목 없음)",
                              en: "(Untitled)",
                              ja: "(無題)",
                              zh: "(Untitled)",
                              de: "(Kein Titel)",
                            })}
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
                          {t({ ko: "불러오기", en: "Load", ja: "読み込み", zh: "Load", de: "Laden" })}
                        </button>
                        <button
                          type="button"
                          onClick={() => onDeleteDraft(draft.id)}
                          className="rounded-md border border-red-500/70 px-2.5 py-1 text-xs font-semibold text-red-300 transition hover:bg-red-500/10"
                        >
                          {t({ ko: "삭제", en: "Delete", ja: "削除", zh: "Delete", de: "Löschen" })}
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
                {t({ ko: "전체 삭제", en: "Delete All", ja: "すべて削除", zh: "Delete All", de: "Alle löschen" })}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
