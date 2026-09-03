import { useState, useMemo } from "react";
import type { SubTask } from "../../types";
import { useI18n } from "../../i18n";

interface TimelineEvent {
  id: string;
  type: "subtask" | "file" | "tool" | "test_pass" | "test_fail" | "command" | "commit";
  label: string;
  timestamp: number;
  isActive?: boolean;
}

const EVENT_STYLES: Record<TimelineEvent["type"], { color: string; icon: string }> = {
  subtask: { color: "#34d399", icon: "●" },
  file: { color: "#3b82f6", icon: "◆" },
  tool: { color: "#8b5cf6", icon: "◇" },
  test_pass: { color: "#34d399", icon: "✓" },
  test_fail: { color: "#ef4444", icon: "✗" },
  command: { color: "#eab308", icon: "▸" },
  commit: { color: "#34d399", icon: "◆" },
};

// CLI events have no reliable per-line timestamps; use 0 as sentinel so the UI omits the timestamp column.
function parseCliEvents(streamTail: string): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  const lines = streamTail.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const fileWrite = line.match(/(?:Write|Created?)\s+(?:file:?\s*)?(.+)/i);
    if (fileWrite) {
      events.push({ id: `cli-file-${i}`, type: "file", label: fileWrite[1].trim(), timestamp: 0 });
      continue;
    }

    const fileEdit = line.match(/Edit\s+(?:file:?\s*)?(.+)/i);
    if (fileEdit) {
      events.push({ id: `cli-edit-${i}`, type: "file", label: `${fileEdit[1].trim()} (edited)`, timestamp: 0 });
      continue;
    }

    if (/[✓✔]|PASS|passed/i.test(line) && !/FAIL/i.test(line)) {
      const short = line.length > 60 ? line.slice(0, 57) + "..." : line;
      events.push({ id: `cli-pass-${i}`, type: "test_pass", label: short, timestamp: 0 });
      continue;
    }

    if (/[✗✘]|FAIL|failed/i.test(line)) {
      const short = line.length > 60 ? line.slice(0, 57) + "..." : line;
      events.push({ id: `cli-fail-${i}`, type: "test_fail", label: short, timestamp: 0 });
      continue;
    }

    if (/web_search|WebSearch|fetch\(|curl /i.test(line)) {
      const short = line.length > 60 ? line.slice(0, 57) + "..." : line;
      events.push({ id: `cli-tool-${i}`, type: "tool", label: short, timestamp: 0 });
      continue;
    }

    if (/commit(?:ted)?\s/i.test(line) && /[a-f0-9]{7}/i.test(line)) {
      const short = line.length > 60 ? line.slice(0, 57) + "..." : line;
      events.push({ id: `cli-commit-${i}`, type: "commit", label: short, timestamp: 0 });
      continue;
    }

    if (/^\$\s+/.test(line) || /^Running:?\s+/i.test(line)) {
      const cmd = line.replace(/^\$\s+/, "").replace(/^Running:?\s+/i, "");
      events.push({ id: `cli-cmd-${i}`, type: "command", label: cmd, timestamp: 0 });
      continue;
    }
  }

  return events;
}

function formatRelativeTime(
  timestamp: number,
  t: (text: { ko: string; en: string; ja?: string; zh?: string; de?: string }) => string,
): string {
  const diff = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diff < 5) return t({ ko: "방금", en: "now", ja: "今", zh: "刚才", de: "jetzt" });
  if (diff < 60)
    return t({ ko: `${diff}초 전`, en: `${diff}s ago`, ja: `${diff}秒前`, zh: `${diff}秒前`, de: `vor ${diff}s` });
  if (diff < 3600)
    return t({
      ko: `${Math.floor(diff / 60)}분 전`,
      en: `${Math.floor(diff / 60)}m ago`,
      ja: `${Math.floor(diff / 60)}分前`,
      zh: `${Math.floor(diff / 60)}分前`,
      de: `vor ${Math.floor(diff / 60)}m`,
    });
  return t({
    ko: `${Math.floor(diff / 3600)}시간 전`,
    en: `${Math.floor(diff / 3600)}h ago`,
    ja: `${Math.floor(diff / 3600)}時間前`,
    zh: `${Math.floor(diff / 3600)}小时前`,
    de: `vor ${Math.floor(diff / 3600)}h`,
  });
}

interface ActivityTimelineProps {
  subtasks: SubTask[];
  taskId: string | null;
  streamTail: string;
}

export default function ActivityTimeline({ subtasks, taskId, streamTail }: ActivityTimelineProps) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);

  const subtaskEvents: TimelineEvent[] = useMemo(() => {
    return subtasks
      .filter((s) => s.task_id === taskId)
      .map((s) => ({
        id: `st-${s.id}`,
        type: "subtask" as const,
        label: `${s.title}${s.status === "done" ? " ✓" : s.status === "in_progress" ? "" : ` (${s.status})`}`,
        timestamp: s.completed_at ?? s.created_at,
        isActive: s.status === "in_progress",
      }));
  }, [subtasks, taskId]);

  const cliEvents = useMemo(() => parseCliEvents(streamTail), [streamTail]);

  const displayEvents = useMemo(() => {
    if (expanded) {
      return [...subtaskEvents, ...cliEvents].sort((a, b) => a.timestamp - b.timestamp);
    }
    return subtaskEvents.slice(-8);
  }, [expanded, subtaskEvents, cliEvents]);

  const totalEvents = subtaskEvents.length + cliEvents.length;
  const hiddenCount = expanded ? 0 : totalEvents - displayEvents.length;

  return (
    <div
      style={{
        flex: 1,
        padding: "10px 12px",
        overflowY: "auto",
        display: "flex",
        flexDirection: "column",
        gap: 4,
        minHeight: 0,
      }}
    >
      <div
        style={{
          fontFamily: "JetBrains Mono, monospace",
          fontSize: 9,
          color: "var(--text-muted)",
          letterSpacing: "0.08em",
          marginBottom: 4,
          flexShrink: 0,
        }}
      >
        {t({ ko: "활동", en: "ACTIVITY", ja: "アクティビティ", zh: "活动", de: "AKTIVITÄT" })}
      </div>

      {displayEvents.length === 0 && (
        <div
          style={{
            fontFamily: "JetBrains Mono, monospace",
            fontSize: 10,
            color: "var(--text-muted)",
            opacity: 0.5,
            padding: "16px 0",
            textAlign: "center",
          }}
        >
          {t({
            ko: "출력 대기 중...",
            en: "Waiting for output...",
            ja: "出力待機中...",
            zh: "等待输出...",
            de: "Warte auf Ausgabe...",
          })}
        </div>
      )}

      {displayEvents.map((event) => {
        const style = EVENT_STYLES[event.type];
        return (
          <div key={event.id} style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
            <div
              style={{
                width: 16,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                flexShrink: 0,
                paddingTop: 2,
              }}
            >
              <span
                style={{
                  color: style.color,
                  fontSize: 10,
                  lineHeight: 1,
                  ...(event.isActive ? { textShadow: `0 0 6px ${style.color}66` } : {}),
                }}
              >
                {style.icon}
              </span>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontFamily: "JetBrains Mono, monospace",
                  fontSize: 10,
                  color: event.isActive ? "var(--accent)" : "var(--text-secondary)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {event.label}
              </div>
            </div>
            {event.timestamp > 0 && (
              <div
                style={{
                  fontFamily: "JetBrains Mono, monospace",
                  fontSize: 9,
                  color: "var(--text-muted)",
                  opacity: 0.5,
                  flexShrink: 0,
                  whiteSpace: "nowrap",
                }}
              >
                {formatRelativeTime(event.timestamp, t)}
              </div>
            )}
          </div>
        );
      })}

      {hiddenCount > 0 && (
        <button
          onClick={() => setExpanded(true)}
          style={{
            fontFamily: "JetBrains Mono, monospace",
            fontSize: 9,
            color: "var(--text-muted)",
            background: "var(--bg-surface)",
            border: "1px solid var(--border)",
            borderRadius: 4,
            padding: "4px 8px",
            cursor: "pointer",
            textAlign: "center",
            marginTop: 4,
            transition: "background 0.15s",
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = "var(--bg-surface-hover)";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = "var(--bg-surface)";
          }}
        >
          ▸{" "}
          {t({
            ko: `${hiddenCount}개 더 보기`,
            en: `Show ${hiddenCount} more`,
            ja: `${hiddenCount}件をさらに表示`,
            zh: `显示更多 ${hiddenCount} 条`,
            de: `${hiddenCount} weitere anzeigen`,
          })}
        </button>
      )}

      {expanded && cliEvents.length > 0 && (
        <button
          onClick={() => setExpanded(false)}
          style={{
            fontFamily: "JetBrains Mono, monospace",
            fontSize: 9,
            color: "var(--text-muted)",
            background: "none",
            border: "none",
            cursor: "pointer",
            textAlign: "center",
            padding: "2px 0",
          }}
        >
          ▾ {t({ ko: "접기", en: "Collapse", ja: "折りたたむ", zh: "收起", de: "Einklappen" })}
        </button>
      )}
    </div>
  );
}
