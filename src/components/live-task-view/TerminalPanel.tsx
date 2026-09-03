import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n";

interface TerminalPanelProps {
  streamTail: string;
}

export default function TerminalPanel({ streamTail }: TerminalPanelProps) {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!collapsed && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [streamTail, collapsed]);

  return (
    <div
      style={{
        borderTop: "1px solid var(--border)",
        background: "var(--bg-base)",
        flexShrink: 0,
      }}
    >
      <button
        onClick={() => setCollapsed((c) => !c)}
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          width: "100%",
          padding: "6px 12px",
          cursor: "pointer",
          background: "none",
          border: "none",
          color: "var(--text-muted)",
        }}
      >
        <span
          style={{
            fontFamily: "JetBrains Mono, monospace",
            fontSize: 9,
            letterSpacing: "0.08em",
          }}
        >
          {t({
            ko: "터미널 출력",
            en: "TERMINAL OUTPUT",
            ja: "ターミナル出力",
            zh: "终端输出",
            de: "TERMINAL-AUSGABE",
          })}
        </span>
        <span style={{ fontSize: 10 }}>{collapsed ? "▸" : "▾"}</span>
      </button>

      {!collapsed && (
        <div
          ref={scrollRef}
          style={{
            padding: "0 12px 10px",
            maxHeight: 120,
            overflowY: "auto",
          }}
        >
          <pre
            style={{
              fontFamily: "JetBrains Mono, monospace",
              fontSize: 10,
              lineHeight: 1.6,
              color: "#4ade80",
              background: "var(--bg-surface)",
              padding: 8,
              borderRadius: 4,
              margin: 0,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {streamTail ||
              t({
                ko: "출력 없음...",
                en: "No output yet...",
                ja: "出力なし...",
                zh: "暂无输出...",
                de: "Noch keine Ausgabe...",
              })}
          </pre>
        </div>
      )}
    </div>
  );
}
