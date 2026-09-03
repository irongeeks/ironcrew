import React, { useState, useCallback } from "react";
import type { BrowseEntry, BrowseDirResult } from "../../api/task-browse";

interface FileTreeProps {
  onBrowseDirectory: (relativePath: string) => Promise<BrowseDirResult>;
  initialEntries: BrowseEntry[];
  basePath: string;
  selectedFile: string | null;
  onSelectFile: (relativePath: string) => void;
}

interface TreeNodeProps {
  onBrowseDirectory: (relativePath: string) => Promise<BrowseDirResult>;
  entry: BrowseEntry;
  parentPath: string;
  selectedFile: string | null;
  onSelectFile: (relativePath: string) => void;
}

function gitStatusBadge(status: BrowseEntry["gitStatus"]): React.ReactNode {
  if (!status) return null;
  const map: Record<string, { label: string; color: string }> = {
    modified: { label: "M", color: "var(--accent)" },
    added: { label: "A", color: "#60a5fa" },
    deleted: { label: "D", color: "#f87171" },
    renamed: { label: "R", color: "#fbbf24" },
    untracked: { label: "U", color: "#9ca3af" },
    has_changes: { label: "●", color: "var(--accent)" },
  };
  const info = map[status];
  if (!info) return null;
  return (
    <span className="ml-auto shrink-0 text-[9px] font-bold" style={{ color: info.color }}>
      {info.label}
    </span>
  );
}

function fileIcon(entry: BrowseEntry): string {
  if (entry.type === "directory") return "📂";
  const ext = entry.name.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "svg", "webp", "ico"].includes(ext)) return "🖼️";
  if (["mp4", "webm", "mov"].includes(ext)) return "🎬";
  if (["mp3", "wav", "ogg", "m4a"].includes(ext)) return "🔊";
  if (["md", "mdx"].includes(ext)) return "📝";
  return "📄";
}

function TreeNode({ onBrowseDirectory, entry, parentPath, selectedFile, onSelectFile }: TreeNodeProps) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<BrowseEntry[] | null>(null);
  const [loading, setLoading] = useState(false);

  const fullPath = parentPath ? `${parentPath}/${entry.name}` : entry.name;

  const toggleExpand = useCallback(async () => {
    if (entry.type !== "directory") return;
    if (expanded) {
      setExpanded(false);
      return;
    }
    if (!children) {
      setLoading(true);
      try {
        const result = await onBrowseDirectory(fullPath);
        setChildren(result.ok ? result.entries : []);
      } catch {
        setChildren([]);
      } finally {
        setLoading(false);
      }
    }
    setExpanded(true);
  }, [onBrowseDirectory, fullPath, expanded, children, entry.type]);

  const handleClick = () => {
    if (entry.type === "directory") {
      void toggleExpand();
    } else {
      onSelectFile(fullPath);
    }
  };

  const isSelected = entry.type === "file" && selectedFile === fullPath;

  return (
    <div>
      <button
        type="button"
        onClick={handleClick}
        className="flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-left text-[11px] transition hover:opacity-80"
        style={{
          background: isSelected ? "var(--accent-dim)" : "transparent",
          color: isSelected ? "var(--accent)" : "var(--th-text-primary)",
        }}
      >
        {entry.type === "directory" && (
          <span className="w-3 shrink-0 text-center text-[9px]" style={{ color: "var(--th-text-muted)" }}>
            {loading ? "…" : expanded ? "▼" : "▶"}
          </span>
        )}
        {entry.type === "file" && <span className="w-3 shrink-0" />}
        <span className="shrink-0">{fileIcon(entry)}</span>
        <span className="truncate">{entry.name}</span>
        {gitStatusBadge(entry.gitStatus)}
      </button>
      {expanded && children && (
        <div className="ml-3 border-l" style={{ borderColor: "var(--th-border)" }}>
          {children.map((child) => (
            <TreeNode
              key={child.name}
              onBrowseDirectory={onBrowseDirectory}
              entry={child}
              parentPath={fullPath}
              selectedFile={selectedFile}
              onSelectFile={onSelectFile}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function FileTree({
  onBrowseDirectory,
  initialEntries,
  basePath,
  selectedFile,
  onSelectFile,
}: FileTreeProps) {
  return (
    <div className="overflow-y-auto" style={{ maxHeight: "360px" }}>
      {initialEntries.map((entry) => (
        <TreeNode
          key={entry.name}
          onBrowseDirectory={onBrowseDirectory}
          entry={entry}
          parentPath={basePath}
          selectedFile={selectedFile}
          onSelectFile={onSelectFile}
        />
      ))}
    </div>
  );
}
