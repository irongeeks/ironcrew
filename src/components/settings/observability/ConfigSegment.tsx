import { useEffect, useState } from "react";
import { put, request } from "../../../api/core";
import type { TFunction } from "../types";

export function ConfigSegment({ t }: { t: TFunction }) {
  const [config, setConfig] = useState({
    otlp_endpoint: "",
    otlp_export_interval_ms: 30000,
    otlp_enabled: false,
    log_retention_days: 7,
    metrics_retention_days: 7,
    trace_retention_days: 30,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        // Use the central API layer (injects auth/CSRF headers)
        const data = await request<{ settings: Record<string, unknown> }>("/api/settings");
        const stored = data.settings?.observability_config;
        if (stored && typeof stored === "object") {
          setConfig((prev) => ({ ...prev, ...(stored as Record<string, unknown>) }));
        }
      } catch {
        // Settings may not have observability config yet — use defaults
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      // Use put() from central API layer — injects Bearer + CSRF headers automatically
      await put("/api/settings", { observability_config: config });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      console.error("[Observability] Failed to save config:", err);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12" style={{ color: "var(--th-text-secondary)" }}>
        {t({ en: "Loading...", de: "Laden..." })}
      </div>
    );
  }

  const envIndicator = (envVar: string) => {
    // The backend can check for env-locked values, but on the frontend
    // we just show a hint. In the future the API may return locked flags.
    return (
      <span className="ml-1 text-[10px]" style={{ color: "var(--th-text-secondary)" }} title={`env: ${envVar}`}>
        (env: {envVar})
      </span>
    );
  };

  return (
    <div className="space-y-4">
      {/* OTLP Export */}
      <div
        className="rounded-lg border p-4 space-y-3"
        style={{ borderColor: "var(--th-border)", background: "var(--th-bg-secondary)" }}
      >
        <h4 className="text-sm font-semibold" style={{ color: "var(--th-text-primary)" }}>
          {t({ en: "OTLP Export", de: "OTLP-Export" })}
        </h4>

        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs" style={{ color: "var(--th-text-primary)" }}>
            <input
              type="checkbox"
              checked={config.otlp_enabled}
              onChange={(e) => setConfig((c) => ({ ...c, otlp_enabled: e.target.checked }))}
            />
            {t({ en: "Enabled", de: "Aktiviert" })}
          </label>
          {envIndicator("OTLP_ENABLED")}
        </div>

        <div>
          <label className="block text-xs font-medium mb-1" style={{ color: "var(--th-text-secondary)" }}>
            {t({ en: "Endpoint URL", de: "Endpunkt-URL" })}
          </label>
          <input
            className="w-full rounded border px-2 py-1.5 text-sm font-mono"
            style={{
              borderColor: "var(--th-border)",
              background: "var(--th-bg-primary)",
              color: "var(--th-text-primary)",
            }}
            placeholder="http://localhost:4318"
            value={config.otlp_endpoint}
            onChange={(e) => setConfig((c) => ({ ...c, otlp_endpoint: e.target.value }))}
          />
        </div>

        <div>
          <label className="block text-xs font-medium mb-1" style={{ color: "var(--th-text-secondary)" }}>
            {t({ en: "Export Interval (ms)", de: "Export-Intervall (ms)" })}
          </label>
          <input
            type="number"
            className="w-32 rounded border px-2 py-1.5 text-sm"
            style={{
              borderColor: "var(--th-border)",
              background: "var(--th-bg-primary)",
              color: "var(--th-text-primary)",
            }}
            min={5000}
            step={5000}
            value={config.otlp_export_interval_ms}
            onChange={(e) =>
              setConfig((c) => ({ ...c, otlp_export_interval_ms: Math.max(5000, Number(e.target.value) || 60000) }))
            }
          />
        </div>
      </div>

      {/* Log level is controlled via LOG_LEVEL env var at startup; runtime change not yet supported */}

      {/* Retention */}
      <div
        className="rounded-lg border p-4 space-y-3"
        style={{ borderColor: "var(--th-border)", background: "var(--th-bg-secondary)" }}
      >
        <h4 className="text-sm font-semibold" style={{ color: "var(--th-text-primary)" }}>
          {t({ en: "Retention", de: "Aufbewahrung" })}
        </h4>

        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="block text-xs font-medium mb-1" style={{ color: "var(--th-text-secondary)" }}>
              {t({ en: "Logs (days)", de: "Logs (Tage)" })}
            </label>
            <input
              type="number"
              className="w-full rounded border px-2 py-1.5 text-sm"
              style={{
                borderColor: "var(--th-border)",
                background: "var(--th-bg-primary)",
                color: "var(--th-text-primary)",
              }}
              min={1}
              max={365}
              value={config.log_retention_days}
              onChange={(e) =>
                setConfig((c) => ({ ...c, log_retention_days: Math.max(1, Number(e.target.value) || 30) }))
              }
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1" style={{ color: "var(--th-text-secondary)" }}>
              {t({ en: "Metrics (days)", de: "Metriken (Tage)" })}
            </label>
            <input
              type="number"
              className="w-full rounded border px-2 py-1.5 text-sm"
              style={{
                borderColor: "var(--th-border)",
                background: "var(--th-bg-primary)",
                color: "var(--th-text-primary)",
              }}
              min={1}
              max={365}
              value={config.metrics_retention_days}
              onChange={(e) =>
                setConfig((c) => ({ ...c, metrics_retention_days: Math.max(1, Number(e.target.value) || 90) }))
              }
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1" style={{ color: "var(--th-text-secondary)" }}>
              {t({ en: "Traces (days)", de: "Traces (Tage)" })}
            </label>
            <input
              type="number"
              className="w-full rounded border px-2 py-1.5 text-sm"
              style={{
                borderColor: "var(--th-border)",
                background: "var(--th-bg-primary)",
                color: "var(--th-text-primary)",
              }}
              min={1}
              max={365}
              value={config.trace_retention_days}
              onChange={(e) =>
                setConfig((c) => ({ ...c, trace_retention_days: Math.max(1, Number(e.target.value) || 30) }))
              }
            />
          </div>
        </div>
      </div>

      {/* Save button */}
      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={saving}
          className="rounded-lg px-4 py-1.5 text-xs font-medium text-white transition-colors disabled:opacity-50"
          style={{ background: "var(--th-accent, #3b82f6)" }}
        >
          {saving ? t({ en: "Saving...", de: "Speichern..." }) : t({ en: "Save", de: "Speichern" })}
        </button>
        {saved && (
          <span className="text-xs" style={{ color: "#22c55e" }}>
            {t({ en: "Saved!", de: "Gespeichert!" })}
          </span>
        )}
      </div>
    </div>
  );
}
