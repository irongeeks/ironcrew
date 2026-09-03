import type { RefObject } from "react";
import type { TaskLogEntry } from "./model";

type TrFn = (ko: string, en: string, ja?: string, zh?: string, de?: string) => string;

export interface TerminalTabProps {
  text: string;
  taskLogs: TaskLogEntry[];
  taskStatus: string | undefined;
  shouldShowProgressHints: boolean;
  taskLogTimeFormatter: Intl.DateTimeFormat;
  containerRef: RefObject<HTMLDivElement | null>;
  preRef: RefObject<HTMLPreElement | null>;
  onScroll: () => void;
  tr: TrFn;
}

export function TerminalTab({
  text,
  taskLogs,
  taskStatus,
  shouldShowProgressHints,
  taskLogTimeFormatter,
  containerRef,
  preRef,
  onScroll,
  tr,
}: TerminalTabProps) {
  return (
    <>
      {/* Task log markers (system events) */}
      {taskLogs.length > 0 && (
        <div className="terminal-panel-strip max-h-24 space-y-0.5 overflow-y-auto border-b px-4 py-2">
          {taskLogs.map((log) => {
            const kindColor =
              log.kind === "error" ? "text-red-400" : log.kind === "system" ? "text-emerald-400" : "text-zinc-500";
            const time = taskLogTimeFormatter.format(new Date(log.created_at));
            return (
              <div key={log.id} className={`terminal-log-line font-mono ${kindColor}`}>
                [{time}] {log.message}
              </div>
            );
          })}
        </div>
      )}

      {/* Terminal body */}
      <div ref={containerRef} className="terminal-panel-body flex-1 overflow-y-auto p-4" onScroll={onScroll}>
        {!text ? (
          <div className="flex flex-col items-center justify-center h-full" style={{ color: "var(--th-text-muted)" }}>
            <div className="text-3xl mb-3">
              {taskStatus === "in_progress" ? (
                <span className="inline-block animate-spin">&#9881;</span>
              ) : (
                <span>&#128421;</span>
              )}
            </div>
            <div className="text-sm">
              {taskStatus === "in_progress"
                ? shouldShowProgressHints
                  ? tr(
                      "도구 실행 중...",
                      "Tools are running...",
                      "ツール実行中...",
                      "工具正在运行...",
                      "Werkzeuge laufen...",
                    )
                  : tr(
                      "출력을 기다리는 중...",
                      "Waiting for output...",
                      "出力待機中...",
                      "正在等待输出...",
                      "Warte auf Ausgabe...",
                    )
                : tr(
                    "아직 터미널 출력이 없습니다",
                    "No terminal output yet",
                    "まだターミナル出力がありません",
                    "暂无终端输出",
                    "Noch keine Terminalausgabe",
                  )}
            </div>
          </div>
        ) : (
          <pre
            ref={preRef}
            className="text-[13px] leading-6 font-mono whitespace-pre-wrap break-words terminal-output-text"
          >
            {text}
          </pre>
        )}
      </div>
    </>
  );
}
