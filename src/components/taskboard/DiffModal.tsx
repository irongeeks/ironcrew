import { useState, useCallback, useEffect } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../i18n";
import { discardTask, getTaskDiff, mergeTask, type TaskDiffResult } from "../../api";

interface DiffModalProps {
  taskId: string;
  onClose: () => void;
}

function DiffModal({ taskId, onClose }: DiffModalProps) {
  const { t } = useI18n();
  const [diffData, setDiffData] = useState<TaskDiffResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [actionResult, setActionResult] = useState<string | null>(null);

  useEffect(() => {
    getTaskDiff(taskId)
      .then((d) => {
        if (!d.ok)
          setError(
            d.error ||
              t({
                ko: "알 수 없는 오류",
                en: "Unknown error",
                ja: "不明なエラー",
                zh: "Unknown error",
                de: "Unbekannter Fehler",
              }),
          );
        else setDiffData(d);
        setLoading(false);
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
  }, [taskId, t]);

  // Close on Escape key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const handleMerge = useCallback(async () => {
    if (
      !confirm(
        t({
          ko: "이 브랜치를 메인에 병합하시겠습니까?",
          en: "Merge this branch into main?",
          ja: "このブランチを main にマージしますか？",
          zh: "Merge this branch into main?",
          de: "Diesen Branch in main zusammenführen?",
        }),
      )
    )
      return;
    setMerging(true);
    try {
      const result = await mergeTask(taskId);
      setActionResult(
        result.ok
          ? `${t({ ko: "병합 완료", en: "Merge completed", ja: "マージ完了", zh: "Merge completed", de: "Zusammenführung abgeschlossen" })}: ${result.message}`
          : `${t({ ko: "병합 실패", en: "Merge failed", ja: "マージ失敗", zh: "Merge failed", de: "Zusammenführung fehlgeschlagen" })}: ${result.message}`,
      );
      if (result.ok) setTimeout(onClose, 1500);
    } catch (e: unknown) {
      setActionResult(
        `${t({ ko: "오류", en: "Error", ja: "エラー", zh: "Error", de: "Fehler" })}: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setMerging(false);
    }
  }, [taskId, onClose, t]);

  const handleDiscard = useCallback(async () => {
    if (
      !confirm(
        t({
          ko: "이 브랜치의 변경사항을 모두 폐기하시겠습니까? 이 작업은 되돌릴 수 없습니다.",
          en: "Discard all changes in this branch? This action cannot be undone.",
          ja: "このブランチの変更をすべて破棄しますか？この操作は元に戻せません。",
          zh: "Discard all changes in this branch? This action cannot be undone.",
          de: "Alle Änderungen in diesem Branch verwerfen? Diese Aktion kann nicht rückgängig gemacht werden.",
        }),
      )
    )
      return;
    setDiscarding(true);
    try {
      const result = await discardTask(taskId);
      setActionResult(
        result.ok
          ? t({
              ko: "브랜치가 폐기되었습니다.",
              en: "Branch was discarded.",
              ja: "ブランチを破棄しました。",
              zh: "Branch was discarded.",
              de: "Branch wurde verworfen.",
            })
          : `${t({ ko: "폐기 실패", en: "Discard failed", ja: "破棄失敗", zh: "Discard failed", de: "Verwerfen fehlgeschlagen" })}: ${result.message}`,
      );
      if (result.ok) setTimeout(onClose, 1500);
    } catch (e: unknown) {
      setActionResult(
        `${t({ ko: "오류", en: "Error", ja: "エラー", zh: "Error", de: "Fehler" })}: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setDiscarding(false);
    }
  }, [taskId, onClose, t]);

  const modal = (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-5xl flex-col rounded-2xl border shadow-2xl"
        style={{ borderColor: "var(--th-border)", background: "#1a1f2e" }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between border-b px-5 py-3"
          style={{ borderColor: "var(--th-border)" }}
        >
          <div className="flex items-center gap-2">
            <span className="text-lg font-bold" style={{ color: "var(--th-text-heading)" }}>
              {t({ ko: "Git 변경사항", en: "Git Diff", ja: "Git 差分", zh: "Git Diff", de: "Git Diff" })}
            </span>
            {diffData?.branchName && (
              <span className="rounded-full bg-purple-900 px-2.5 py-0.5 text-xs text-purple-300">
                {diffData.branchName}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleMerge}
              disabled={merging || discarding || !diffData?.hasWorktree}
              className="rounded-lg bg-green-700 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-green-600 disabled:opacity-40"
            >
              {merging ? "..." : t({ ko: "병합", en: "Merge", ja: "マージ", zh: "Merge", de: "Zusammenführen" })}
            </button>
            <button
              onClick={handleDiscard}
              disabled={merging || discarding || !diffData?.hasWorktree}
              className="rounded-lg bg-red-800 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-red-700 disabled:opacity-40"
            >
              {discarding ? "..." : t({ ko: "폐기", en: "Discard", ja: "破棄", zh: "Discard", de: "Verwerfen" })}
            </button>
            <button
              onClick={onClose}
              className="rounded-lg p-1.5 transition hover:text-white"
              style={{ color: "var(--th-text-secondary)" }}
              title={t({ ko: "닫기", en: "Close", ja: "閉じる", zh: "Close", de: "Schließen" })}
            >
              X
            </button>
          </div>
        </div>

        {/* Action result */}
        {actionResult && (
          <div
            className="border-b px-5 py-2 text-sm text-amber-300"
            style={{ borderColor: "var(--th-border)", background: "var(--th-card-bg)" }}
          >
            {actionResult}
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-auto p-6">
          {loading ? (
            <div className="flex items-center justify-center py-12" style={{ color: "var(--th-text-secondary)" }}>
              {t({
                ko: "변경사항 불러오는 중...",
                en: "Loading diff...",
                ja: "差分を読み込み中...",
                zh: "Loading diff...",
                de: "Diff wird geladen...",
              })}
            </div>
          ) : error ? (
            <div className="flex items-center justify-center py-12 text-red-400">
              {t({ ko: "오류", en: "Error", ja: "エラー", zh: "Error", de: "Fehler" })}: {error}
            </div>
          ) : !diffData?.hasWorktree ? (
            <div className="flex items-center justify-center py-12" style={{ color: "var(--th-text-muted)" }}>
              {t({
                ko: "이 작업의 워크트리를 찾을 수 없습니다. (Git 프로젝트 아님 또는 이미 병합됨)",
                en: "No worktree found for this task (non-git project or already merged)",
                ja: "このタスクのワークツリーが見つかりません（Git プロジェクトではない、または既にマージ済み）",
                zh: "No worktree found for this task (non-git project or already merged)",
                de: "Kein Worktree für diese Aufgabe gefunden (kein Git-Projekt oder bereits zusammengeführt)",
              })}
            </div>
          ) : (
            <div className="space-y-4">
              {/* Stat summary */}
              {diffData.stat && (
                <div>
                  <h3 className="mb-1 text-sm font-semibold" style={{ color: "var(--th-text-secondary)" }}>
                    {t({ ko: "요약", en: "Summary", ja: "概要", zh: "Summary", de: "Zusammenfassung" })}
                  </h3>
                  <pre
                    className="rounded-lg p-3 text-sm overflow-x-auto"
                    style={{ background: "#111827", color: "#9ca3af" }}
                  >
                    {diffData.stat}
                  </pre>
                </div>
              )}
              {/* Full diff */}
              {diffData.diff && (
                <div>
                  <h3 className="mb-1 text-sm font-semibold" style={{ color: "var(--th-text-secondary)" }}>
                    {t({ ko: "Diff", en: "Diff", ja: "差分", zh: "Diff", de: "Diff" })}
                  </h3>
                  <pre
                    className="max-h-[60vh] overflow-auto rounded-lg p-4 text-sm leading-relaxed"
                    style={{ background: "#0d1117" }}
                  >
                    {diffData.diff.split("\n").map((line, i) => {
                      let cls = "text-slate-400";
                      if (line.startsWith("+") && !line.startsWith("+++")) cls = "text-green-400";
                      else if (line.startsWith("-") && !line.startsWith("---")) cls = "text-red-400";
                      else if (line.startsWith("@@")) cls = "text-cyan-400";
                      else if (line.startsWith("diff ") || line.startsWith("index ")) cls = "text-slate-500 font-bold";
                      return (
                        <span key={i} className={cls}>
                          {line}
                          {"\n"}
                        </span>
                      );
                    })}
                  </pre>
                </div>
              )}
              {!diffData.stat && !diffData.diff && (
                <div className="text-center py-8" style={{ color: "var(--th-text-muted)" }}>
                  {t({
                    ko: "변경사항이 없습니다",
                    en: "No changes detected",
                    ja: "変更はありません",
                    zh: "No changes detected",
                    de: "Keine Änderungen gefunden",
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}

export default DiffModal;
