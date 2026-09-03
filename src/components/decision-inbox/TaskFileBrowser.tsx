import { useState, useEffect, useCallback } from "react";
import type { BrowseEntry, BrowseDirResult, BrowseFileResult } from "../../api/task-browse";
import { browseTaskDirectory, browseTaskFile, browseProjectDirectory, browseProjectFile } from "../../api/task-browse";
import FileTree from "./FileTree";
import FileViewer from "./FileViewer";
import { pickLang } from "../../i18n";
import type { UiLanguage } from "../../i18n";

interface TaskFileBrowserProps {
  taskId?: string | null;
  projectPath?: string | null;
  uiLanguage: UiLanguage;
  agentName?: string;
  onOpenDiff?: (taskId: string) => void;
  onOpenTerminal?: (taskId: string) => void;
}

function countChanges(entries: BrowseEntry[]): { modified: number; added: number; hasNestedChanges: boolean } {
  let modified = 0;
  let added = 0;
  let hasNestedChanges = false;
  for (const e of entries) {
    if (e.gitStatus === "modified") modified++;
    else if (e.gitStatus === "added" || e.gitStatus === "untracked") added++;
    else if (e.gitStatus === "has_changes") hasNestedChanges = true;
  }
  return { modified, added, hasNestedChanges };
}

export default function TaskFileBrowser({
  taskId,
  projectPath,
  uiLanguage,
  agentName,
  onOpenDiff,
  onOpenTerminal,
}: TaskFileBrowserProps) {
  const t = (text: { ko: string; en: string; de?: string }) => pickLang(uiLanguage, text);
  const [expanded, setExpanded] = useState(false);
  const [rootData, setRootData] = useState<BrowseDirResult | null>(null);
  const [rootLoading, setRootLoading] = useState(false);
  const [rootError, setRootError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileData, setFileData] = useState<BrowseFileResult | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  // Track which file request is current to prevent stale-response races (Fix #5)
  const [fileRequestId, setFileRequestId] = useState(0);

  const loadRoot = useCallback(async () => {
    setRootLoading(true);
    setRootError(null);
    try {
      const data = taskId
        ? await browseTaskDirectory(taskId, "/")
        : projectPath
          ? await browseProjectDirectory(projectPath, "/")
          : null;
      if (!data || !data.ok) {
        setRootError(data?.error ?? "no_source");
        return;
      }
      setRootData(data);
    } catch {
      setRootError("fetch_failed");
    } finally {
      setRootLoading(false);
    }
  }, [taskId, projectPath]);

  useEffect(() => {
    if (expanded && !rootData && !rootLoading && !rootError) {
      void loadRoot();
    }
  }, [expanded, rootData, rootLoading, rootError, loadRoot]);

  const handleSelectFile = useCallback(
    async (relativePath: string) => {
      const reqId = fileRequestId + 1;
      setFileRequestId(reqId);
      setSelectedFile(relativePath);
      setFileLoading(true);
      try {
        const data = taskId
          ? await browseTaskFile(taskId, relativePath)
          : projectPath
            ? await browseProjectFile(projectPath, relativePath)
            : null;
        setFileRequestId((current) => {
          if (current === reqId) {
            setFileData(data?.ok ? data : null);
            setFileLoading(false);
          }
          return current;
        });
      } catch {
        setFileRequestId((current) => {
          if (current === reqId) {
            setFileData(null);
            setFileLoading(false);
          }
          return current;
        });
      }
    },
    [taskId, projectPath, fileRequestId],
  );

  // Collapsed header with summary
  const summaryLabel = rootData
    ? (() => {
        const { modified, added, hasNestedChanges } = countChanges(rootData.entries);
        const parts: string[] = [];
        if (modified > 0) parts.push(`${modified} ${t({ ko: "수정", en: "modified", de: "geändert" })}`);
        if (added > 0) parts.push(`${added} ${t({ ko: "추가", en: "added", de: "neu" })}`);
        if (parts.length === 0 && hasNestedChanges) {
          return t({ ko: "하위 변경 있음", en: "nested changes", de: "verschachtelte Änderungen" });
        }
        return parts.length > 0 ? parts.join(", ") : t({ ko: "변경 없음", en: "no changes", de: "keine Änderungen" });
      })()
    : null;

  return (
    <div
      className="mt-2 overflow-hidden rounded-lg border"
      style={{ borderColor: "var(--th-border)", background: "var(--th-bg-secondary)" }}
    >
      {/* Collapsed header bar */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-2.5 py-2 text-left transition hover:opacity-80"
        style={{ background: "var(--th-card-bg)" }}
      >
        <span className="text-[10px]" style={{ color: "var(--th-text-muted)" }}>
          {expanded ? "▼" : "▶"}
        </span>
        <span className="text-[11px] font-medium" style={{ color: "var(--th-text-primary)" }}>
          {t({ ko: "작업 결과", en: "Work Result", de: "Arbeitsergebnis" })}
        </span>
        {agentName && (
          <span className="text-[10px]" style={{ color: "var(--th-text-secondary)" }}>
            — {agentName}
          </span>
        )}
        {rootData?.branchName && (
          <span className="text-[10px]" style={{ color: "var(--accent)" }}>
            🌿 {rootData.branchName}
          </span>
        )}
        {summaryLabel && (
          <span className="ml-auto text-[10px]" style={{ color: "var(--th-text-muted)" }}>
            {summaryLabel}
          </span>
        )}
      </button>

      {/* Expanded body */}
      {expanded && (
        <div>
          {rootLoading && (
            <div className="px-3 py-4 text-center text-[11px]" style={{ color: "var(--th-text-muted)" }}>
              {t({ ko: "로딩 중...", en: "Loading...", de: "Laden..." })}
            </div>
          )}
          {rootError && (
            <div className="px-3 py-4 text-center text-[11px]" style={{ color: "var(--th-text-muted)" }}>
              {rootError === "no_project_path"
                ? t({ ko: "프로젝트 경로 없음", en: "No project path", de: "Kein Projektpfad" })
                : t({ ko: "파일 로드 실패", en: "Failed to load files", de: "Dateien konnten nicht geladen werden" })}
            </div>
          )}
          {rootData && !rootLoading && (
            <>
              {/* Project path */}
              <div
                className="border-t px-2.5 py-1"
                style={{ borderColor: "var(--th-border)", color: "var(--th-text-muted)" }}
              >
                <span className="text-[10px]">📂 {rootData.basePath}</span>
              </div>
              {/* Split view */}
              <div className="flex border-t" style={{ borderColor: "var(--th-border)", height: "400px" }}>
                {/* Tree pane */}
                <div
                  className="shrink-0 overflow-y-auto border-r p-1"
                  style={{ width: "35%", borderColor: "var(--th-border)" }}
                >
                  <FileTree
                    onBrowseDirectory={(rp) =>
                      taskId ? browseTaskDirectory(taskId, rp) : browseProjectDirectory(projectPath!, rp)
                    }
                    initialEntries={rootData.entries}
                    basePath=""
                    selectedFile={selectedFile}
                    onSelectFile={handleSelectFile}
                  />
                </div>
                {/* Viewer pane */}
                <div className="min-w-0 flex-1">
                  <FileViewer file={fileData} loading={fileLoading} uiLanguage={uiLanguage} />
                </div>
              </div>
            </>
          )}

          {/* Quick links */}
          <div
            className="flex items-center gap-2 border-t px-2.5 py-1.5"
            style={{ borderColor: "var(--th-border)", background: "var(--th-card-bg)" }}
          >
            {onOpenDiff && taskId && (
              <button
                type="button"
                onClick={() => onOpenDiff(taskId)}
                className="rounded px-2 py-0.5 text-[10px] font-medium transition hover:opacity-80"
                style={{ background: "var(--accent-dim)", color: "var(--accent)" }}
              >
                {t({ ko: "Diff 보기", en: "View Diff", de: "Diff anzeigen" })}
              </button>
            )}
            {onOpenTerminal && taskId && (
              <button
                type="button"
                onClick={() => onOpenTerminal(taskId)}
                className="rounded px-2 py-0.5 text-[10px] font-medium transition hover:opacity-80"
                style={{
                  background: "var(--th-bg-surface-hover)",
                  color: "var(--th-text-secondary)",
                }}
              >
                {t({ ko: "터미널 로그", en: "Terminal Log", de: "Terminal-Log" })}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
