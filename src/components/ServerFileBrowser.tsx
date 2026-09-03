import { useEffect, useState } from "react";
import { listRemoteDirectory, createRemoteDirectory, readRemoteFile, deleteRemoteFile } from "../api/server-ssh";
import type { RemoteFileEntry } from "../types/index";

interface ServerFileBrowserProps {
  serverId: string;
  initialPath?: string;
  compact?: boolean;
  onSelectPath?: (path: string) => void;
}

function formatSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileIcon(type: RemoteFileEntry["type"]): string {
  if (type === "directory") return "📁";
  if (type === "symlink") return "🔗";
  return "📄";
}

function buildBreadcrumbs(path: string): { label: string; path: string }[] {
  if (!path || path === "/") return [{ label: "/", path: "/" }];
  const normalized = path.startsWith("/") ? path : `/${path}`;
  const parts = normalized.split("/").filter(Boolean);
  const crumbs: { label: string; path: string }[] = [{ label: "/", path: "/" }];
  let accumulated = "";
  for (const part of parts) {
    accumulated += `/${part}`;
    crumbs.push({ label: part, path: accumulated });
  }
  return crumbs;
}

function sortEntries(entries: RemoteFileEntry[]): RemoteFileEntry[] {
  return [...entries].sort((a, b) => {
    if (a.type === "directory" && b.type !== "directory") return -1;
    if (a.type !== "directory" && b.type === "directory") return 1;
    return a.name.localeCompare(b.name);
  });
}

export default function ServerFileBrowser({
  serverId,
  initialPath = "~",
  compact = false,
  onSelectPath,
}: ServerFileBrowserProps) {
  const [currentPath, setCurrentPath] = useState(initialPath);
  const [entries, setEntries] = useState<RemoteFileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState("");
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [previewContent, setPreviewContent] = useState<{ path: string; content: string } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [pathInput, setPathInput] = useState(initialPath);
  const [deletingPath, setDeletingPath] = useState<string | null>(null);
  const [hoveredPath, setHoveredPath] = useState<string | null>(null);

  const loadDirectory = async (path: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await listRemoteDirectory(serverId, path);
      setCurrentPath(result.path);
      setPathInput(result.path);
      setEntries(sortEntries(result.entries));
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadDirectory(initialPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, initialPath]);

  const handleNavigate = (path: string) => {
    void loadDirectory(path);
  };

  const handleEntryClick = (entry: RemoteFileEntry) => {
    if (entry.type === "directory") {
      handleNavigate(entry.path);
    } else {
      void handlePreview(entry.path);
    }
  };

  const handlePreview = async (path: string) => {
    setPreviewLoading(true);
    setPreviewContent(null);
    try {
      const result = await readRemoteFile(serverId, path);
      setPreviewContent({ path, content: result.content });
    } catch (err) {
      setPreviewContent({ path, content: `Error reading file: ${String(err)}` });
    } finally {
      setPreviewLoading(false);
    }
  };

  const handlePathInputSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (pathInput.trim()) {
      handleNavigate(pathInput.trim());
    }
  };

  const handleCreateFolder = async () => {
    if (!newFolderName.trim()) return;
    const newPath = currentPath.endsWith("/")
      ? `${currentPath}${newFolderName.trim()}`
      : `${currentPath}/${newFolderName.trim()}`;
    setCreatingFolder(true);
    try {
      await createRemoteDirectory(serverId, newPath);
      setNewFolderName("");
      setShowNewFolder(false);
      void loadDirectory(currentPath);
    } catch (err) {
      setError(`Failed to create folder: ${String(err)}`);
    } finally {
      setCreatingFolder(false);
    }
  };

  const handleDelete = async (entry: RemoteFileEntry) => {
    if (!window.confirm(`Delete "${entry.name}"?`)) return;
    setDeletingPath(entry.path);
    try {
      await deleteRemoteFile(serverId, entry.path);
      void loadDirectory(currentPath);
    } catch (err) {
      setError(`Failed to delete: ${String(err)}`);
    } finally {
      setDeletingPath(null);
    }
  };

  const breadcrumbs = buildBreadcrumbs(currentPath);
  const textSize = compact ? "text-[11px]" : "text-xs";

  return (
    <div
      className="flex flex-col overflow-hidden rounded-md border"
      style={{ borderColor: "var(--th-border)", background: "var(--th-bg-primary)" }}
    >
      {/* Toolbar */}
      <div
        className="flex items-center gap-2 border-b px-3 py-2"
        style={{ borderColor: "var(--th-border)", background: "var(--th-bg-secondary)" }}
      >
        {/* Breadcrumbs */}
        <div
          className={`flex min-w-0 flex-1 flex-wrap items-center gap-0.5 ${textSize}`}
          style={{ color: "var(--th-text-secondary)" }}
        >
          {breadcrumbs.map((crumb, index) => (
            <span key={crumb.path} className="flex items-center gap-0.5">
              {index > 0 && <span className="opacity-40">/</span>}
              <button
                className="max-w-[120px] truncate rounded px-1 py-0.5 hover:underline"
                style={{ color: "var(--th-accent)" }}
                onClick={() => handleNavigate(crumb.path)}
                title={crumb.path}
              >
                {crumb.label}
              </button>
            </span>
          ))}
        </div>

        {/* Actions */}
        <div className="flex shrink-0 items-center gap-1">
          <button
            className={`rounded border px-2 py-0.5 ${textSize}`}
            style={{ borderColor: "var(--th-border)", color: "var(--th-text-secondary)" }}
            onClick={() => setShowNewFolder((v) => !v)}
            title="New Folder"
          >
            + Folder
          </button>
          <button
            className={`rounded border px-2 py-0.5 ${textSize}`}
            style={{ borderColor: "var(--th-border)", color: "var(--th-text-secondary)" }}
            onClick={() => void loadDirectory(currentPath)}
            disabled={loading}
            title="Refresh"
          >
            ↻
          </button>
          {compact && onSelectPath && (
            <button
              className={`rounded border px-2 py-0.5 ${textSize}`}
              style={{ borderColor: "var(--th-accent)", color: "var(--th-accent)" }}
              onClick={() => onSelectPath(currentPath)}
            >
              Select
            </button>
          )}
        </div>
      </div>

      {/* Path input */}
      <form
        onSubmit={handlePathInputSubmit}
        className="flex items-center gap-1 border-b px-3 py-1.5"
        style={{ borderColor: "var(--th-border)" }}
      >
        <input
          className={`min-w-0 flex-1 rounded border px-2 py-0.5 font-mono ${textSize}`}
          style={{
            background: "var(--th-bg-primary)",
            borderColor: "var(--th-border)",
            color: "var(--th-text-primary)",
          }}
          value={pathInput}
          onChange={(e) => setPathInput(e.target.value)}
          placeholder="Enter path..."
          spellCheck={false}
        />
        <button
          type="submit"
          className={`shrink-0 rounded border px-2 py-0.5 ${textSize}`}
          style={{ borderColor: "var(--th-border)", color: "var(--th-text-secondary)" }}
          disabled={loading}
        >
          Go
        </button>
      </form>

      {/* New folder row */}
      {showNewFolder && (
        <div
          className="flex items-center gap-2 border-b px-3 py-1.5"
          style={{ borderColor: "var(--th-border)", background: "var(--th-bg-secondary)" }}
        >
          <span className="text-base">📁</span>
          <input
            autoFocus
            className={`min-w-0 flex-1 rounded border px-2 py-0.5 ${textSize}`}
            style={{
              background: "var(--th-bg-primary)",
              borderColor: "var(--th-border)",
              color: "var(--th-text-primary)",
            }}
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            placeholder="Folder name"
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleCreateFolder();
              if (e.key === "Escape") {
                setShowNewFolder(false);
                setNewFolderName("");
              }
            }}
          />
          <button
            className={`shrink-0 rounded border px-2 py-0.5 ${textSize}`}
            style={{ borderColor: "var(--th-border)", color: "var(--th-text-secondary)" }}
            onClick={() => void handleCreateFolder()}
            disabled={creatingFolder || !newFolderName.trim()}
          >
            {creatingFolder ? "..." : "Create"}
          </button>
          <button
            className={`shrink-0 rounded border px-2 py-0.5 ${textSize}`}
            style={{ borderColor: "var(--th-border)", color: "var(--th-text-secondary)" }}
            onClick={() => {
              setShowNewFolder(false);
              setNewFolderName("");
            }}
          >
            ✕
          </button>
        </div>
      )}

      {/* Error */}
      {error && (
        <div
          className={`border-b px-3 py-2 ${textSize}`}
          style={{
            borderColor: "var(--th-border)",
            color: "var(--th-error, #ef4444)",
            background: "rgba(239,68,68,0.08)",
          }}
        >
          {error}
          <button className="ml-2 underline opacity-70" onClick={() => setError(null)}>
            dismiss
          </button>
        </div>
      )}

      {/* File listing */}
      <div className={`overflow-auto ${compact ? "max-h-48" : "max-h-80"}`}>
        {loading && (
          <div className={`px-3 py-4 text-center ${textSize}`} style={{ color: "var(--th-text-secondary)" }}>
            Loading...
          </div>
        )}
        {!loading && entries.length === 0 && !error && (
          <div className={`px-3 py-4 text-center ${textSize}`} style={{ color: "var(--th-text-secondary)" }}>
            Empty directory
          </div>
        )}
        {!loading && entries.length > 0 && (
          <table className="w-full border-collapse">
            <thead>
              <tr
                className={`sticky top-0 border-b ${textSize}`}
                style={{
                  borderColor: "var(--th-border)",
                  background: "var(--th-bg-secondary)",
                  color: "var(--th-text-secondary)",
                }}
              >
                <th className="px-3 py-1 text-left font-normal">Name</th>
                <th className="px-3 py-1 text-left font-normal">Type</th>
                {!compact && <th className="px-3 py-1 text-right font-normal">Size</th>}
                {!compact && <th className="px-3 py-1 text-left font-normal">Modified</th>}
                <th className="w-8 px-2 py-1" />
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr
                  key={entry.path}
                  className="group border-b"
                  style={{ borderColor: "var(--th-border)" }}
                  onMouseEnter={() => setHoveredPath(entry.path)}
                  onMouseLeave={() => setHoveredPath(null)}
                >
                  <td className="px-3 py-1">
                    <button
                      className={`flex min-w-0 items-center gap-1.5 text-left ${textSize} hover:underline`}
                      style={{ color: entry.type === "directory" ? "var(--th-accent)" : "var(--th-text-primary)" }}
                      onClick={() => handleEntryClick(entry)}
                    >
                      <span>{fileIcon(entry.type)}</span>
                      <span className="truncate">{entry.name}</span>
                    </button>
                  </td>
                  <td className={`px-3 py-1 ${textSize}`} style={{ color: "var(--th-text-secondary)" }}>
                    {entry.type}
                  </td>
                  {!compact && (
                    <td className={`px-3 py-1 text-right ${textSize}`} style={{ color: "var(--th-text-secondary)" }}>
                      {entry.type === "file" ? formatSize(entry.size) : "—"}
                    </td>
                  )}
                  {!compact && (
                    <td className={`px-3 py-1 ${textSize}`} style={{ color: "var(--th-text-secondary)" }}>
                      {entry.modified ? new Date(entry.modified).toLocaleDateString() : "—"}
                    </td>
                  )}
                  <td className="px-2 py-1">
                    {(hoveredPath === entry.path || deletingPath === entry.path) && (
                      <button
                        className={`rounded px-1.5 py-0.5 ${textSize} opacity-60 hover:opacity-100`}
                        style={{ color: "var(--th-error, #ef4444)" }}
                        onClick={() => void handleDelete(entry)}
                        disabled={deletingPath === entry.path}
                        title="Delete"
                      >
                        {deletingPath === entry.path ? "..." : "✕"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Preview modal */}
      {(previewContent || previewLoading) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div
            className="flex w-[calc(100vw-2rem)] max-w-2xl flex-col overflow-hidden border shadow-2xl"
            style={{
              background: "var(--th-bg-secondary)",
              borderColor: "var(--th-border)",
              borderRadius: "var(--radius-lg, 8px)",
              maxHeight: "80vh",
            }}
          >
            <div
              className="flex items-center justify-between border-b px-4 py-2"
              style={{ borderColor: "var(--th-border)" }}
            >
              <span className="truncate text-xs font-medium" style={{ color: "var(--th-text-heading)" }}>
                {previewContent?.path ?? "Loading..."}
              </span>
              <button
                className="ml-2 shrink-0 rounded border px-2 py-0.5 text-xs"
                style={{ borderColor: "var(--th-border)", color: "var(--th-text-secondary)" }}
                onClick={() => setPreviewContent(null)}
              >
                Close
              </button>
            </div>
            <div className="overflow-auto p-4">
              {previewLoading ? (
                <div className="text-xs" style={{ color: "var(--th-text-secondary)" }}>
                  Loading file...
                </div>
              ) : (
                <pre
                  className="whitespace-pre-wrap break-all font-mono text-xs"
                  style={{ color: "var(--th-text-primary)" }}
                >
                  {previewContent?.content}
                </pre>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
