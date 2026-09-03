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
          <p className="text-sm text-[var(--th-text-primary)]">
            {t({
              ko: "해당 경로가 없습니다. 추가하시겠습니까?",
              en: "This path does not exist. Create it now?",
              ja: "このパスは存在しません。作成しますか？",
              zh: "This path does not exist. Create it now?",
              de: "Dieser Pfad existiert nicht. Jetzt erstellen?",
            })}
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
                ko: "현재 권한으로 해당 경로를 생성할 수 없습니다. 다른 경로를 선택해주세요.",
                en: "This path is not creatable with current permissions. Choose another path.",
                ja: "現在の権限ではこのパスを作成できません。別のパスを指定してください。",
                zh: "This path is not creatable with current permissions. Choose another path.",
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
            {t({ ko: "취소", en: "Cancel", ja: "キャンセル", zh: "Cancel", de: "Abbrechen" })}
          </button>
          <button
            type="button"
            disabled={!prompt.canCreate || saving}
            onClick={onConfirmCreate}
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t({ ko: "예", en: "Yes", ja: "はい", zh: "Yes", de: "Ja" })}
          </button>
        </div>
      </div>
    </div>
  );
}
