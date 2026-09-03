import { useState } from "react";
import type { BrowseFileResult } from "../../api/task-browse";
import MessageContent from "../MessageContent";
import { pickLang } from "../../i18n";
import type { UiLanguage } from "../../i18n";

interface FileViewerProps {
  file: BrowseFileResult | null;
  loading: boolean;
  uiLanguage: UiLanguage;
}

const MAX_DISPLAY_LINES = 500;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function TextViewer({ content, language: _language }: { content: string; language: string | null }) {
  const lines = content.split("\n");
  const truncated = lines.length > MAX_DISPLAY_LINES;
  const displayLines = truncated ? lines.slice(0, MAX_DISPLAY_LINES) : lines;

  return (
    <div className="overflow-auto" style={{ maxHeight: "340px" }}>
      <table className="w-full border-collapse text-[11px]" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
        <tbody>
          {displayLines.map((line, i) => (
            <tr key={i} className="hover:opacity-80">
              <td
                className="select-none pr-3 text-right"
                style={{
                  color: "var(--th-text-muted)",
                  minWidth: "2.5rem",
                  userSelect: "none",
                }}
              >
                {i + 1}
              </td>
              <td className="whitespace-pre" style={{ color: "var(--th-text-primary)" }}>
                {line || " "}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {truncated && (
        <div
          className="border-t px-3 py-1.5 text-center text-[10px]"
          style={{ borderColor: "var(--th-border)", color: "var(--th-text-muted)" }}
        >
          File truncated — showing first {MAX_DISPLAY_LINES} of {lines.length} lines
        </div>
      )}
    </div>
  );
}

function MarkdownViewer({ content, uiLanguage }: { content: string; uiLanguage: UiLanguage }) {
  const [showRaw, setShowRaw] = useState(false);
  const t = (text: { ko: string; en: string; de?: string }) => pickLang(uiLanguage, text);

  return (
    <div>
      <div className="flex justify-end px-2 py-1">
        <button
          type="button"
          onClick={() => setShowRaw(!showRaw)}
          className="rounded px-2 py-0.5 text-[10px] font-medium transition hover:opacity-80"
          style={{ background: "var(--accent-dim)", color: "var(--accent)" }}
        >
          {showRaw
            ? t({ ko: "미리보기", en: "Preview", de: "Vorschau" })
            : t({ ko: "소스 보기", en: "View Source", de: "Quelltext" })}
        </button>
      </div>
      <div className="overflow-auto px-3 pb-2" style={{ maxHeight: "320px" }}>
        {showRaw ? (
          <pre
            className="whitespace-pre-wrap text-[11px]"
            style={{ fontFamily: "'JetBrains Mono', monospace", color: "var(--th-text-primary)" }}
          >
            {content}
          </pre>
        ) : (
          <div className="prose-sm text-[12px]" style={{ color: "var(--th-text-primary)" }}>
            <MessageContent content={content} />
          </div>
        )}
      </div>
    </div>
  );
}

function ImageViewer({ streamUrl }: { streamUrl: string }) {
  const [fullscreen, setFullscreen] = useState(false);

  return (
    <>
      <div className="flex items-center justify-center overflow-auto p-3" style={{ maxHeight: "340px" }}>
        <img
          src={streamUrl}
          alt=""
          className="max-h-80 max-w-full cursor-pointer rounded object-contain"
          style={{ imageRendering: "auto" }}
          onClick={() => setFullscreen(true)}
        />
      </div>
      {fullscreen && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80"
          onClick={() => setFullscreen(false)}
        >
          <img src={streamUrl} alt="" className="max-h-[90vh] max-w-[90vw] rounded object-contain" />
        </div>
      )}
    </>
  );
}

function VideoViewer({ streamUrl, mimeType }: { streamUrl: string; mimeType: string }) {
  return (
    <div className="flex items-center justify-center p-3" style={{ maxHeight: "340px" }}>
      <video controls className="max-h-72 max-w-full rounded" preload="metadata">
        <source src={streamUrl} type={mimeType} />
      </video>
    </div>
  );
}

function AudioViewer({ streamUrl, mimeType }: { streamUrl: string; mimeType: string }) {
  return (
    <div className="flex items-center justify-center p-4">
      <audio controls className="w-full max-w-md" preload="metadata">
        <source src={streamUrl} type={mimeType} />
      </audio>
    </div>
  );
}

function PdfViewer({ streamUrl }: { streamUrl: string }) {
  return (
    <div className="overflow-hidden rounded" style={{ height: "340px" }}>
      <iframe src={streamUrl} className="h-full w-full border-0" title="PDF preview" />
    </div>
  );
}

function BinaryViewer({ file, uiLanguage }: { file: BrowseFileResult; uiLanguage: UiLanguage }) {
  const t = (text: { ko: string; en: string; de?: string }) => pickLang(uiLanguage, text);
  return (
    <div className="flex flex-col items-center justify-center gap-2 p-6" style={{ color: "var(--th-text-secondary)" }}>
      <span className="text-3xl">📦</span>
      <span className="text-xs">{file.relativePath}</span>
      <span className="text-[10px]">{formatSize(file.size)}</span>
      {file.streamUrl && (
        <a
          href={file.streamUrl}
          download
          className="mt-1 rounded px-3 py-1 text-[11px] font-medium transition hover:opacity-80"
          style={{ background: "var(--accent-dim)", color: "var(--accent)" }}
        >
          {t({ ko: "다운로드", en: "Download", de: "Herunterladen" })}
        </a>
      )}
    </div>
  );
}

export default function FileViewer({ file, loading, uiLanguage }: FileViewerProps) {
  const t = (text: { ko: string; en: string; de?: string }) => pickLang(uiLanguage, text);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center p-6" style={{ color: "var(--th-text-muted)" }}>
        <span className="text-xs">{t({ ko: "로딩 중...", en: "Loading...", de: "Laden..." })}</span>
      </div>
    );
  }

  if (!file) {
    return (
      <div className="flex h-full items-center justify-center p-6" style={{ color: "var(--th-text-muted)" }}>
        <span className="text-xs">
          {t({
            ko: "파일을 선택하세요",
            en: "Select a file to preview",
            de: "Datei auswählen",
          })}
        </span>
      </div>
    );
  }

  // Respect server's streamUrl: null for oversized files — don't synthesize a URL
  const streamUrl = file.streamUrl ?? null;
  const isStreamable = streamUrl !== null;

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div
        className="flex items-center gap-2 border-b px-2.5 py-1.5"
        style={{ borderColor: "var(--th-border)", background: "var(--th-card-bg)" }}
      >
        <span className="truncate text-[11px] font-medium" style={{ color: "var(--th-text-primary)" }}>
          {file.relativePath}
        </span>
        {file.gitStatus && (
          <span
            className="shrink-0 text-[9px] font-bold"
            style={{
              color:
                file.gitStatus === "added" ? "#60a5fa" : file.gitStatus === "deleted" ? "#f87171" : "var(--accent)",
            }}
          >
            {file.gitStatus}
          </span>
        )}
        <span className="ml-auto shrink-0 text-[10px]" style={{ color: "var(--th-text-muted)" }}>
          {formatSize(file.size)}
        </span>
      </div>

      {/* Content */}
      <div className="min-h-0 flex-1">
        {file.error === "file_too_large" && <BinaryViewer file={file} uiLanguage={uiLanguage} />}
        {!file.error && file.type === "text" && file.content != null && (
          <TextViewer content={file.content} language={file.language} />
        )}
        {!file.error && file.type === "markdown" && file.content != null && (
          <MarkdownViewer content={file.content} uiLanguage={uiLanguage} />
        )}
        {!file.error && file.type === "image" && isStreamable && <ImageViewer streamUrl={streamUrl} />}
        {!file.error && file.type === "video" && isStreamable && (
          <VideoViewer streamUrl={streamUrl} mimeType={file.mimeType} />
        )}
        {!file.error && file.type === "audio" && isStreamable && (
          <AudioViewer streamUrl={streamUrl} mimeType={file.mimeType} />
        )}
        {!file.error && file.type === "pdf" && isStreamable && <PdfViewer streamUrl={streamUrl} />}
        {!file.error && !isStreamable && ["image", "video", "audio", "pdf"].includes(file.type) && (
          <BinaryViewer file={file} uiLanguage={uiLanguage} />
        )}
        {!file.error && file.type === "binary" && <BinaryViewer file={file} uiLanguage={uiLanguage} />}
      </div>
    </div>
  );
}
