import { useCallback, useEffect, useRef, useState } from "react";
import { fetchLogs, type ObsLogEntry } from "../../../api/observability";
import type { TFunction } from "../types";
import { formatTime, levelColor, levelLabel } from "./utils";

export function LogsSegment({ t }: { t: TFunction }) {
  const [logs, setLogs] = useState<ObsLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [offset, setOffset] = useState(0);
  const [levelFilter, setLevelFilter] = useState<number | undefined>(undefined);
  const [moduleFilter, setModuleFilter] = useState("");
  const [searchText, setSearchText] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const LIMIT = 100;

  const loadLogs = useCallback(async () => {
    try {
      const result = await fetchLogs({
        limit: LIMIT,
        offset,
        level: levelFilter,
        module: moduleFilter || undefined,
        search: searchText || undefined,
      });
      setLogs(result.logs);
      setTotal(result.total);
    } catch (err) {
      console.error("[Observability] Failed to load logs:", err);
    } finally {
      setLoading(false);
    }
  }, [offset, levelFilter, moduleFilter, searchText]);

  useEffect(() => {
    setLoading(true);
    void loadLogs();
  }, [loadLogs]);

  useEffect(() => {
    if (autoRefresh) {
      timerRef.current = setInterval(() => void loadLogs(), 5000);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [autoRefresh, loadLogs]);

  const hasNext = offset + LIMIT < total;
  const hasPrev = offset > 0;

  return (
    <div className="space-y-3">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="rounded border px-2 py-1.5 text-xs"
          style={{
            borderColor: "var(--th-border)",
            background: "var(--th-bg-primary)",
            color: "var(--th-text-primary)",
          }}
          value={levelFilter ?? ""}
          onChange={(e) => {
            setLevelFilter(e.target.value ? Number(e.target.value) : undefined);
            setOffset(0);
          }}
        >
          <option value="">
            {t({ ko: "전체 레벨", en: "All Levels", ja: "全レベル", zh: "All Levels", de: "Alle Level" })}
          </option>
          <option value="50">ERROR+</option>
          <option value="40">WARN+</option>
          <option value="30">INFO+</option>
          <option value="20">DEBUG+</option>
          <option value="10">TRACE+</option>
        </select>

        <input
          className="rounded border px-2 py-1.5 text-xs"
          style={{
            borderColor: "var(--th-border)",
            background: "var(--th-bg-primary)",
            color: "var(--th-text-primary)",
          }}
          placeholder={t({ ko: "모듈 필터", en: "Module filter", ja: "モジュール", zh: "Module", de: "Modul" })}
          value={moduleFilter}
          onChange={(e) => {
            setModuleFilter(e.target.value);
            setOffset(0);
          }}
        />

        <input
          className="flex-1 rounded border px-2 py-1.5 text-xs"
          style={{
            borderColor: "var(--th-border)",
            background: "var(--th-bg-primary)",
            color: "var(--th-text-primary)",
            minWidth: 120,
          }}
          placeholder={t({ ko: "검색...", en: "Search...", ja: "検索...", zh: "Search...", de: "Suche..." })}
          value={searchText}
          onChange={(e) => {
            setSearchText(e.target.value);
            setOffset(0);
          }}
        />

        <label className="flex items-center gap-1 text-xs" style={{ color: "var(--th-text-secondary)" }}>
          <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
          {t({ ko: "자동 새로고침", en: "Auto-refresh", ja: "自動更新", zh: "Auto-refresh", de: "Auto-Refresh" })}
        </label>
      </div>

      {/* Table */}
      <div className="overflow-auto rounded-lg border" style={{ borderColor: "var(--th-border)", maxHeight: 480 }}>
        {loading ? (
          <div className="flex items-center justify-center py-12" style={{ color: "var(--th-text-secondary)" }}>
            {t({ ko: "로딩 중...", en: "Loading...", ja: "読み込み中...", zh: "Loading...", de: "Laden..." })}
          </div>
        ) : logs.length === 0 ? (
          <div className="py-8 text-center text-xs" style={{ color: "var(--th-text-secondary)" }}>
            {t({ ko: "로그가 없습니다", en: "No logs found", ja: "ログがありません", zh: "No logs", de: "Keine Logs" })}
          </div>
        ) : (
          <table className="w-full text-xs" style={{ fontFamily: "monospace" }}>
            <thead>
              <tr style={{ background: "var(--th-bg-secondary)", color: "var(--th-text-secondary)" }}>
                <th className="whitespace-nowrap px-2 py-1.5 text-left font-medium">
                  {t({ ko: "시간", en: "Time", ja: "時刻", zh: "Time", de: "Zeit" })}
                </th>
                <th className="whitespace-nowrap px-2 py-1.5 text-left font-medium">
                  {t({ ko: "레벨", en: "Level", ja: "レベル", zh: "Level", de: "Level" })}
                </th>
                <th className="whitespace-nowrap px-2 py-1.5 text-left font-medium">
                  {t({ ko: "모듈", en: "Module", ja: "モジュール", zh: "Module", de: "Modul" })}
                </th>
                <th className="px-2 py-1.5 text-left font-medium">
                  {t({ ko: "메시지", en: "Message", ja: "メッセージ", zh: "Message", de: "Nachricht" })}
                </th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr
                  key={log.id}
                  className="border-t hover:opacity-80"
                  style={{ borderColor: "var(--th-border)", color: "var(--th-text-primary)" }}
                >
                  <td className="whitespace-nowrap px-2 py-1" style={{ color: "var(--th-text-secondary)" }}>
                    {formatTime(log.logged_at)}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1">
                    <span
                      className="inline-block rounded px-1.5 py-0.5 text-[10px] font-bold"
                      style={{ background: `${levelColor(log.level)}22`, color: levelColor(log.level) }}
                    >
                      {levelLabel(log.level)}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-2 py-1" style={{ color: "var(--th-text-secondary)" }}>
                    {log.module ?? "-"}
                  </td>
                  <td className="max-w-md truncate px-2 py-1">{log.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between text-xs" style={{ color: "var(--th-text-secondary)" }}>
        <span>
          {t({ ko: "총", en: "Total:", ja: "合計:", zh: "Total:", de: "Gesamt:" })} {total}
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setOffset(Math.max(0, offset - LIMIT))}
            disabled={!hasPrev}
            className="rounded px-2 py-1 transition-colors disabled:opacity-30"
            style={{ color: "var(--th-text-primary)" }}
          >
            &larr; {t({ ko: "이전", en: "Prev", ja: "前", zh: "Prev", de: "Zurück" })}
          </button>
          <span>
            {offset + 1}–{Math.min(offset + LIMIT, total)}
          </span>
          <button
            onClick={() => setOffset(offset + LIMIT)}
            disabled={!hasNext}
            className="rounded px-2 py-1 transition-colors disabled:opacity-30"
            style={{ color: "var(--th-text-primary)" }}
          >
            {t({ ko: "다음", en: "Next", ja: "次", zh: "Next", de: "Weiter" })} &rarr;
          </button>
        </div>
      </div>
    </div>
  );
}
