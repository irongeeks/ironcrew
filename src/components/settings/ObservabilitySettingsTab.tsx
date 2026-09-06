import { useState } from "react";
import type { TFunction } from "./types";
import { LogsSegment } from "./observability/LogsSegment";
import { TracesSegment } from "./observability/TracesSegment";
import { MetricsSegment } from "./observability/MetricsSegment";
import { ConfigSegment } from "./observability/ConfigSegment";

interface ObservabilitySettingsTabProps {
  t: TFunction;
}

type Segment = "logs" | "traces" | "metrics" | "config";

export default function ObservabilitySettingsTab({ t }: ObservabilitySettingsTabProps) {
  const [segment, setSegment] = useState<Segment>("logs");

  const segmentItems: Array<{ key: Segment; label: string }> = [
    { key: "logs", label: t({ en: "Logs", de: "Logs" }) },
    { key: "traces", label: t({ en: "Traces", de: "Traces" }) },
    { key: "metrics", label: t({ en: "Metrics", de: "Metriken" }) },
    { key: "config", label: t({ en: "Config", de: "Konfig" }) },
  ];

  return (
    <div className="space-y-4">
      {/* Header */}
      <div>
        <h3 className="text-base font-semibold" style={{ color: "var(--th-text-primary)" }}>
          {t({ en: "Observability", de: "Observability" })}
        </h3>
        <p className="mt-0.5 text-xs" style={{ color: "var(--th-text-secondary)" }}>
          {t({
            en: "View logs, traces, metrics and manage observability settings",
            de: "Logs, Traces, Metriken ansehen und Observability-Einstellungen verwalten",
          })}
        </p>
      </div>

      {/* Segmented control */}
      <div
        className="inline-flex rounded-lg border p-0.5"
        style={{ borderColor: "var(--th-border)", background: "var(--th-bg-secondary)" }}
      >
        {segmentItems.map((item) => (
          <button
            key={item.key}
            onClick={() => setSegment(item.key)}
            className="rounded-md px-3 py-1.5 text-xs font-medium transition-colors"
            style={
              segment === item.key
                ? { background: "var(--th-accent, #3b82f6)", color: "#fff" }
                : { color: "var(--th-text-secondary)" }
            }
          >
            {item.label}
          </button>
        ))}
      </div>

      {/* Segments */}
      {segment === "logs" && <LogsSegment t={t} />}
      {segment === "traces" && <TracesSegment t={t} />}
      {segment === "metrics" && <MetricsSegment t={t} />}
      {segment === "config" && <ConfigSegment t={t} />}
    </div>
  );
}
