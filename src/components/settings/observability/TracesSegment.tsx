import { useCallback, useEffect, useState } from "react";
import { fetchTraces, fetchTraceDetail, type ObsTraceRow, type ObsSpan } from "../../../api/observability";
import type { TFunction } from "../types";
import { statusColor, formatDuration, formatDateTime } from "./utils";

export function TracesSegment({ t }: { t: TFunction }) {
  const [traces, setTraces] = useState<ObsTraceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [offset, setOffset] = useState(0);
  const [selectedTrace, setSelectedTrace] = useState<string | null>(null);
  const [spans, setSpans] = useState<ObsSpan[]>([]);
  const [spansLoading, setSpansLoading] = useState(false);
  const [selectedSpan, setSelectedSpan] = useState<ObsSpan | null>(null);
  const LIMIT = 50;

  const loadTraces = useCallback(async () => {
    try {
      const result = await fetchTraces({ limit: LIMIT, offset });
      setTraces(result.traces);
    } catch (err) {
      console.error("[Observability] Failed to load traces:", err);
    } finally {
      setLoading(false);
    }
  }, [offset]);

  useEffect(() => {
    setLoading(true);
    void loadTraces();
  }, [loadTraces]);

  const handleSelectTrace = useCallback(
    async (traceId: string) => {
      if (selectedTrace === traceId) {
        setSelectedTrace(null);
        setSpans([]);
        setSelectedSpan(null);
        return;
      }
      setSelectedTrace(traceId);
      setSelectedSpan(null);
      setSpansLoading(true);
      try {
        const result = await fetchTraceDetail(traceId);
        setSpans(result.spans);
      } catch (err) {
        console.error("[Observability] Failed to load trace detail:", err);
      } finally {
        setSpansLoading(false);
      }
    },
    [selectedTrace],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12" style={{ color: "var(--th-text-secondary)" }}>
        {t({ ko: "로딩 중...", en: "Loading...", ja: "読み込み中...", zh: "Loading...", de: "Laden..." })}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Trace list */}
      {traces.length === 0 ? (
        <div
          className="rounded-lg border py-8 text-center text-xs"
          style={{ borderColor: "var(--th-border)", color: "var(--th-text-secondary)" }}
        >
          {t({
            ko: "트레이스가 없습니다",
            en: "No traces found",
            ja: "トレースがありません",
            zh: "No traces",
            de: "Keine Traces",
          })}
        </div>
      ) : (
        <div className="overflow-auto rounded-lg border" style={{ borderColor: "var(--th-border)" }}>
          <table className="w-full text-xs">
            <thead>
              <tr style={{ background: "var(--th-bg-secondary)", color: "var(--th-text-secondary)" }}>
                <th className="whitespace-nowrap px-2 py-1.5 text-left font-medium">Trace ID</th>
                <th className="whitespace-nowrap px-2 py-1.5 text-left font-medium">Task ID</th>
                <th className="whitespace-nowrap px-2 py-1.5 text-left font-medium">
                  {t({ ko: "이름", en: "Name", ja: "名前", zh: "Name", de: "Name" })}
                </th>
                <th className="whitespace-nowrap px-2 py-1.5 text-left font-medium">
                  {t({ ko: "상태", en: "Status", ja: "ステータス", zh: "Status", de: "Status" })}
                </th>
                <th className="whitespace-nowrap px-2 py-1.5 text-left font-medium">
                  {t({ ko: "소요 시간", en: "Duration", ja: "所要時間", zh: "Duration", de: "Dauer" })}
                </th>
                <th className="whitespace-nowrap px-2 py-1.5 text-left font-medium">Spans</th>
                <th className="whitespace-nowrap px-2 py-1.5 text-left font-medium">
                  {t({ ko: "시작", en: "Started", ja: "開始", zh: "Started", de: "Gestartet" })}
                </th>
              </tr>
            </thead>
            <tbody>
              {traces.map((tr) => {
                const duration = tr.end_time ? tr.end_time - tr.start_time : null;
                return (
                  <tr
                    key={tr.trace_id}
                    className="cursor-pointer border-t transition-colors hover:opacity-80"
                    style={{
                      borderColor: "var(--th-border)",
                      color: "var(--th-text-primary)",
                      background: selectedTrace === tr.trace_id ? "var(--th-bg-secondary)" : undefined,
                    }}
                    onClick={() => void handleSelectTrace(tr.trace_id)}
                  >
                    <td
                      className="whitespace-nowrap px-2 py-1 font-mono text-[10px]"
                      style={{ color: "var(--th-text-secondary)" }}
                    >
                      {tr.trace_id.slice(0, 12)}...
                    </td>
                    <td
                      className="whitespace-nowrap px-2 py-1 font-mono text-[10px]"
                      style={{ color: "var(--th-text-secondary)" }}
                    >
                      {tr.task_id ? `${tr.task_id.toString().slice(0, 8)}` : "-"}
                    </td>
                    <td className="max-w-[200px] truncate px-2 py-1">{tr.name}</td>
                    <td className="whitespace-nowrap px-2 py-1">
                      <span
                        className="inline-block rounded px-1.5 py-0.5 text-[10px] font-bold"
                        style={{ background: `${statusColor(tr.status)}22`, color: statusColor(tr.status) }}
                      >
                        {tr.status}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-2 py-1">
                      {duration !== null ? formatDuration(duration) : "-"}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1">{tr.span_count}</td>
                    <td className="whitespace-nowrap px-2 py-1" style={{ color: "var(--th-text-secondary)" }}>
                      {formatDateTime(tr.start_time)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      <div className="flex items-center justify-end gap-2 text-xs" style={{ color: "var(--th-text-secondary)" }}>
        <button
          onClick={() => setOffset(Math.max(0, offset - LIMIT))}
          disabled={offset === 0}
          className="rounded px-2 py-1 transition-colors disabled:opacity-30"
          style={{ color: "var(--th-text-primary)" }}
        >
          &larr; {t({ ko: "이전", en: "Prev", ja: "前", zh: "Prev", de: "Zurück" })}
        </button>
        <button
          onClick={() => setOffset(offset + LIMIT)}
          disabled={traces.length < LIMIT}
          className="rounded px-2 py-1 transition-colors disabled:opacity-30"
          style={{ color: "var(--th-text-primary)" }}
        >
          {t({ ko: "다음", en: "Next", ja: "次", zh: "Next", de: "Weiter" })} &rarr;
        </button>
      </div>

      {/* Span waterfall detail */}
      {selectedTrace && (
        <div
          className="rounded-lg border p-3"
          style={{ borderColor: "var(--th-border)", background: "var(--th-bg-secondary)" }}
        >
          <h4 className="mb-2 text-xs font-semibold" style={{ color: "var(--th-text-primary)" }}>
            {t({
              ko: "스팬 워터폴",
              en: "Span Waterfall",
              ja: "スパン ウォーターフォール",
              zh: "Span Waterfall",
              de: "Span-Wasserfall",
            })}
          </h4>

          {spansLoading ? (
            <div className="py-4 text-center text-xs" style={{ color: "var(--th-text-secondary)" }}>
              {t({ ko: "로딩 중...", en: "Loading...", ja: "読み込み中...", zh: "Loading...", de: "Laden..." })}
            </div>
          ) : spans.length === 0 ? (
            <div className="py-4 text-center text-xs" style={{ color: "var(--th-text-secondary)" }}>
              {t({ ko: "스팬이 없습니다", en: "No spans", ja: "スパンなし", zh: "No spans", de: "Keine Spans" })}
            </div>
          ) : (
            <SpanWaterfall spans={spans} selectedSpan={selectedSpan} onSelectSpan={setSelectedSpan} t={t} />
          )}
        </div>
      )}
    </div>
  );
}

// ---- Span waterfall component ----

function SpanWaterfall({
  spans,
  selectedSpan,
  onSelectSpan,
  t: _t,
}: {
  spans: ObsSpan[];
  selectedSpan: ObsSpan | null;
  onSelectSpan: (span: ObsSpan | null) => void;
  t: TFunction;
}) {
  // Calculate global time range
  const minTime = Math.min(...spans.map((s) => s.start_time));
  const maxTime = Math.max(...spans.map((s) => s.end_time ?? s.start_time));
  const totalDuration = Math.max(maxTime - minTime, 1);

  // Build depth map for indentation
  const depthMap = new Map<string, number>();
  for (const span of spans) {
    if (!span.parent_span_id) {
      depthMap.set(span.id, 0);
    } else {
      const parentDepth = depthMap.get(span.parent_span_id) ?? 0;
      depthMap.set(span.id, parentDepth + 1);
    }
  }

  return (
    <div className="space-y-0.5">
      {spans.map((span) => {
        const depth = depthMap.get(span.id) ?? 0;
        const startPct = ((span.start_time - minTime) / totalDuration) * 100;
        const endPct = (((span.end_time ?? span.start_time) - minTime) / totalDuration) * 100;
        const widthPct = Math.max(endPct - startPct, 0.5);
        const duration = span.end_time ? span.end_time - span.start_time : null;
        const isSelected = selectedSpan?.id === span.id;

        return (
          <div
            key={span.id}
            className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 transition-colors"
            style={{
              paddingLeft: `${depth * 16 + 4}px`,
              background: isSelected ? "var(--th-bg-primary)" : undefined,
            }}
            onClick={() => onSelectSpan(isSelected ? null : span)}
          >
            {/* Name */}
            <span
              className="w-32 flex-shrink-0 truncate text-[10px]"
              style={{ color: "var(--th-text-primary)" }}
              title={span.name}
            >
              {span.name}
            </span>

            {/* Bar */}
            <div className="relative h-4 flex-1 rounded" style={{ background: "var(--th-bg-primary)" }}>
              <div
                className="absolute top-0 h-full rounded"
                style={{
                  left: `${startPct}%`,
                  width: `${widthPct}%`,
                  background: statusColor(span.status),
                  opacity: 0.8,
                  minWidth: 2,
                }}
              />
            </div>

            {/* Duration label */}
            <span className="w-16 flex-shrink-0 text-right text-[10px]" style={{ color: "var(--th-text-secondary)" }}>
              {duration !== null ? formatDuration(duration) : "..."}
            </span>
          </div>
        );
      })}

      {/* Selected span detail */}
      {selectedSpan && (
        <div
          className="mt-2 rounded border p-2 text-xs"
          style={{
            borderColor: "var(--th-border)",
            background: "var(--th-bg-primary)",
            color: "var(--th-text-primary)",
          }}
        >
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            <div>
              <span style={{ color: "var(--th-text-secondary)" }}>Span ID: </span>
              <span className="font-mono text-[10px]">{selectedSpan.id}</span>
            </div>
            <div>
              <span style={{ color: "var(--th-text-secondary)" }}>Kind: </span>
              {selectedSpan.kind}
            </div>
            <div>
              <span style={{ color: "var(--th-text-secondary)" }}>Status: </span>
              <span style={{ color: statusColor(selectedSpan.status) }}>{selectedSpan.status}</span>
            </div>
            <div>
              <span style={{ color: "var(--th-text-secondary)" }}>Start: </span>
              {formatDateTime(selectedSpan.start_time)}
            </div>
            {selectedSpan.end_time && (
              <div>
                <span style={{ color: "var(--th-text-secondary)" }}>End: </span>
                {formatDateTime(selectedSpan.end_time)}
              </div>
            )}
            {selectedSpan.task_id && (
              <div>
                <span style={{ color: "var(--th-text-secondary)" }}>Task ID: </span>
                <span className="font-mono text-[10px]">{selectedSpan.task_id}</span>
              </div>
            )}
          </div>

          {/* Attributes */}
          {selectedSpan.attributes && (
            <div className="mt-2">
              <div className="mb-1 text-[10px] font-semibold" style={{ color: "var(--th-text-secondary)" }}>
                Attributes
              </div>
              <pre
                className="overflow-auto rounded p-1.5 text-[10px]"
                style={{ background: "var(--th-bg-secondary)", maxHeight: 120 }}
              >
                {(() => {
                  try {
                    return JSON.stringify(JSON.parse(selectedSpan.attributes), null, 2);
                  } catch {
                    return selectedSpan.attributes;
                  }
                })()}
              </pre>
            </div>
          )}

          {/* Events */}
          {selectedSpan.events && (
            <div className="mt-2">
              <div className="mb-1 text-[10px] font-semibold" style={{ color: "var(--th-text-secondary)" }}>
                Events
              </div>
              <pre
                className="overflow-auto rounded p-1.5 text-[10px]"
                style={{ background: "var(--th-bg-secondary)", maxHeight: 120 }}
              >
                {(() => {
                  try {
                    return JSON.stringify(JSON.parse(selectedSpan.events), null, 2);
                  } catch {
                    return selectedSpan.events;
                  }
                })()}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
