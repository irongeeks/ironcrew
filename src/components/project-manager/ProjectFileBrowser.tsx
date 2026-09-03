import { useCallback, useEffect, useState } from "react";
import { request } from "../../api/core";

interface Props {
  projectPath: string;
  projectId: string;
}

interface DirEntry {
  name: string;
  type: "file" | "directory";
  size: number;
  gitStatus: string | null;
}

interface BrowseResponse {
  ok: boolean;
  basePath: string;
  branchName: string | null;
  relativePath: string;
  entries: DirEntry[];
}

interface FileContentResponse {
  ok: boolean;
  relativePath: string;
  type: string;
  language: string | null;
  mimeType: string;
  size: number;
  gitStatus: string | null;
  content: string | null;
  error?: string;
}

function formatSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function ProjectFileBrowser({ projectPath }: Props) {
  const [relativePath, setRelativePath] = useState("/");
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [viewingFile, setViewingFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  const loadDirectory = useCallback(
    async (relPath: string) => {
      setLoading(true);
      setError(null);
      setViewingFile(null);
      setFileContent(null);
      try {
        const sp = new URLSearchParams();
        sp.set("projectPath", projectPath);
        if (relPath && relPath !== "/") sp.set("path", relPath);
        const resp = await request<BrowseResponse>(`/api/browse?${sp.toString()}`);
        setEntries(resp.entries);
        setRelativePath(resp.relativePath);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Failed to load directory");
        setEntries([]);
      } finally {
        setLoading(false);
      }
    },
    [projectPath],
  );

  useEffect(() => {
    void loadDirectory("/");
  }, [loadDirectory]);

  const handleNavigate = useCallback(
    (entryName: string) => {
      const next = relativePath === "/" ? entryName : `${relativePath}/${entryName}`;
      void loadDirectory(next);
    },
    [relativePath, loadDirectory],
  );

  const handleGoUp = useCallback(() => {
    if (relativePath === "/" || relativePath === "") return;
    const parts = relativePath.split("/").filter(Boolean);
    parts.pop();
    const parent = parts.length > 0 ? parts.join("/") : "/";
    void loadDirectory(parent);
  }, [relativePath, loadDirectory]);

  const handleViewFile = useCallback(
    async (entryName: string) => {
      const filePath = relativePath === "/" ? entryName : `${relativePath}/${entryName}`;
      setViewingFile(filePath);
      setFileLoading(true);
      setFileError(null);
      setFileContent(null);
      try {
        const sp = new URLSearchParams();
        sp.set("projectPath", projectPath);
        sp.set("path", filePath);
        sp.set("content", "true");
        const resp = await request<FileContentResponse>(`/api/browse?${sp.toString()}`);
        if (resp.error === "file_too_large") {
          setFileError("File too large to preview");
        } else if (resp.content !== null && resp.content !== undefined) {
          setFileContent(resp.content);
        } else {
          setFileError("Binary or unsupported file type");
        }
      } catch (err: unknown) {
        setFileError(err instanceof Error ? err.message : "Failed to load file");
      } finally {
        setFileLoading(false);
      }
    },
    [projectPath, relativePath],
  );

  const breadcrumbParts = relativePath === "/" ? [] : relativePath.split("/").filter(Boolean);

  return (
    <div className="flex flex-col gap-2">
      {/* Breadcrumb */}
      <div className="flex flex-wrap items-center gap-1 text-[11px]" style={{ color: "var(--th-text-muted)" }}>
        <button
          type="button"
          onClick={() => void loadDirectory("/")}
          className="rounded px-1 py-0.5 transition hover:bg-[var(--th-bg-hover)]"
          style={{ color: "var(--th-text-primary)" }}
        >
          /
        </button>
        {breadcrumbParts.map((part, idx) => {
          const pathUpTo = breadcrumbParts.slice(0, idx + 1).join("/");
          const isLast = idx === breadcrumbParts.length - 1;
          return (
            <span key={pathUpTo} className="flex items-center gap-1">
              <span style={{ color: "var(--th-text-muted)" }}>/</span>
              {isLast ? (
                <span style={{ color: "var(--th-text-heading)" }}>{part}</span>
              ) : (
                <button
                  type="button"
                  onClick={() => void loadDirectory(pathUpTo)}
                  className="rounded px-1 py-0.5 transition hover:bg-[var(--th-bg-hover)]"
                  style={{ color: "var(--th-text-primary)" }}
                >
                  {part}
                </button>
              )}
            </span>
          );
        })}
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={relativePath === "/" || relativePath === "" || loading}
          onClick={handleGoUp}
          className="rounded-md border px-2.5 py-1 text-xs font-semibold transition hover:bg-[var(--th-bg-hover)] disabled:cursor-not-allowed disabled:opacity-40"
          style={{ borderColor: "var(--th-border)", color: "var(--th-text-primary)" }}
        >
          ..
        </button>
        <button
          type="button"
          disabled={loading}
          onClick={() => void loadDirectory(relativePath)}
          className="rounded-md border px-2.5 py-1 text-xs font-semibold transition hover:bg-[var(--th-bg-hover)] disabled:cursor-not-allowed disabled:opacity-40"
          style={{ borderColor: "var(--th-border)", color: "var(--th-text-primary)" }}
        >
          Refresh
        </button>
      </div>

      {/* Entry list */}
      <div
        className="max-h-[50dvh] overflow-y-auto rounded-lg border"
        style={{ borderColor: "var(--th-border)", background: "var(--th-card-bg)" }}
      >
        {loading ? (
          <p className="px-3 py-2 text-xs" style={{ color: "var(--th-text-muted)" }}>
            Loading...
          </p>
        ) : error ? (
          <p className="px-3 py-2 text-xs text-rose-400">{error}</p>
        ) : entries.length === 0 ? (
          <p className="px-3 py-2 text-xs" style={{ color: "var(--th-text-muted)" }}>
            Empty directory
          </p>
        ) : (
          entries.map((entry) => (
            <button
              key={entry.name}
              type="button"
              onClick={() => {
                if (entry.type === "directory") {
                  handleNavigate(entry.name);
                } else {
                  void handleViewFile(entry.name);
                }
              }}
              className="flex w-full items-center gap-2 border-b px-3 py-2 text-left transition hover:bg-[var(--th-bg-hover)]"
              style={{ borderColor: "var(--th-border)" }}
            >
              <span className="w-4 shrink-0 text-center text-xs" style={{ color: "var(--th-text-muted)" }}>
                {entry.type === "directory" ? "\uD83D\uDCC1" : "\uD83D\uDCC4"}
              </span>
              <span
                className="min-w-0 flex-1 truncate text-xs font-semibold"
                style={{ color: "var(--th-text-primary)" }}
              >
                {entry.name}
              </span>
              {entry.type === "file" && (
                <span className="shrink-0 text-[11px]" style={{ color: "var(--th-text-muted)" }}>
                  {formatSize(entry.size)}
                </span>
              )}
            </button>
          ))
        )}
      </div>

      {/* File preview */}
      {viewingFile && (
        <div className="rounded-lg border" style={{ borderColor: "var(--th-border)", background: "var(--th-bg-base)" }}>
          <div
            className="flex items-center justify-between border-b px-3 py-2"
            style={{ borderColor: "var(--th-border)" }}
          >
            <span className="min-w-0 truncate text-xs font-semibold" style={{ color: "var(--th-text-heading)" }}>
              {viewingFile}
            </span>
            <button
              type="button"
              onClick={() => {
                setViewingFile(null);
                setFileContent(null);
                setFileError(null);
              }}
              className="shrink-0 rounded-md px-2 py-0.5 text-xs transition hover:bg-[var(--th-bg-hover)]"
              style={{ color: "var(--th-text-muted)" }}
            >
              Close
            </button>
          </div>
          <div className="max-h-[40dvh] overflow-auto p-3">
            {fileLoading ? (
              <p className="text-xs" style={{ color: "var(--th-text-muted)" }}>
                Loading file...
              </p>
            ) : fileError ? (
              <p className="text-xs text-rose-400">{fileError}</p>
            ) : (
              <pre
                className="whitespace-pre-wrap break-all text-xs leading-relaxed"
                style={{ color: "var(--th-text-primary)", fontFamily: "'JetBrains Mono', monospace" }}
              >
                {fileContent}
              </pre>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
