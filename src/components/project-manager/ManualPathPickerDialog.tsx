import type { ManualPathEntry, ProjectI18nTranslate } from "./types";

interface ManualPathPickerDialogProps {
  open: boolean;
  t: ProjectI18nTranslate;
  manualPathCurrent: string;
  manualPathParent: string | null;
  manualPathEntries: ManualPathEntry[];
  manualPathLoading: boolean;
  manualPathError: string | null;
  manualPathTruncated: boolean;
  onClose: () => void;
  onLoadEntries: (targetPath?: string) => Promise<void>;
  onSelectCurrent: () => void;
}

export default function ManualPathPickerDialog({
  open,
  t,
  manualPathCurrent,
  manualPathParent,
  manualPathEntries,
  manualPathLoading,
  manualPathError,
  manualPathTruncated,
  onClose,
  onLoadEntries,
  onSelectCurrent,
}: ManualPathPickerDialogProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div
        className="w-full max-w-2xl overflow-hidden rounded-xl border shadow-2xl"
        style={{ borderColor: "var(--th-border)", background: "var(--th-card-bg)" }}
        onClick={(e) => e.stopPropagation()}
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
            onClick={onClose}
            className="rounded-md px-2 py-1 text-xs transition hover:bg-[var(--th-bg-surface-hover)] hover:text-[var(--th-text-primary)]"
            style={{ color: "var(--th-text-secondary)" }}
          >
            ✕
          </button>
        </div>
        <div className="space-y-3 px-4 py-4">
          <div
            className="rounded-lg border px-3 py-2"
            style={{ borderColor: "var(--th-border)", background: "var(--th-bg-surface-hover)" }}
          >
            <p className="text-[11px]" style={{ color: "var(--th-text-secondary)" }}>
              {t({
                ko: "현재 위치",
                en: "Current Location",
                ja: "現在位置",
                zh: "Current Location",
                de: "Aktueller Pfad",
              })}
            </p>
            <p className="break-all text-xs text-[var(--th-text-primary)]">{manualPathCurrent || "-"}</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={!manualPathParent || manualPathLoading}
              onClick={() => {
                if (!manualPathParent) return;
                void onLoadEntries(manualPathParent);
              }}
              className="rounded-md border px-2.5 py-1 text-xs font-semibold text-[var(--th-text-primary)] transition hover:bg-[var(--th-bg-surface-hover)] disabled:cursor-not-allowed disabled:opacity-40"
              style={{ borderColor: "var(--th-border-strong)" }}
            >
              {t({ ko: "상위 폴더", en: "Up", ja: "上位フォルダ", zh: "Up", de: "Übergeordneter Ordner" })}
            </button>
            <button
              type="button"
              disabled={manualPathLoading}
              onClick={() => void onLoadEntries(manualPathCurrent || undefined)}
              className="rounded-md border px-2.5 py-1 text-xs font-semibold text-[var(--th-text-primary)] transition hover:bg-[var(--th-bg-surface-hover)] disabled:cursor-not-allowed disabled:opacity-40"
              style={{ borderColor: "var(--th-border-strong)" }}
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
                  de: "Keine auswählbaren Unterordner.",
                })}
              </p>
            ) : (
              manualPathEntries.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  onClick={() => void onLoadEntries(entry.path)}
                  className="w-full border-b px-3 py-2 text-left transition hover:opacity-80"
                  style={{ borderColor: "var(--th-border)" }}
                >
                  <p className="text-xs font-semibold" style={{ color: "var(--th-text-primary)" }}>
                    {entry.name}
                  </p>
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
            onClick={onClose}
            className="rounded-md border px-3 py-1.5 text-xs font-semibold text-[var(--th-text-primary)] transition hover:bg-[var(--th-bg-surface-hover)]"
            style={{ borderColor: "var(--th-border-strong)" }}
          >
            {t({ ko: "취소", en: "Cancel", ja: "キャンセル", zh: "Cancel", de: "Abbrechen" })}
          </button>
          <button
            type="button"
            disabled={!manualPathCurrent}
            onClick={onSelectCurrent}
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
  );
}
