import type { OperationsAlert } from "../../types";

export interface AlertFeedProps {
  title: string;
  alerts: OperationsAlert[];
  emptyLabel: string;
  sourceLabel: string;
  updatedLabel: string;
  formatTime: (ts: number | null) => string;
}

function levelStyle(level: OperationsAlert["level"]): { className: string; style?: React.CSSProperties } {
  if (level === "critical") return { className: "border-rose-500/45 bg-rose-500/10 text-rose-100" };
  if (level === "warning") return { className: "border-amber-500/40 bg-amber-500/10 text-amber-100" };
  return {
    className: "",
    style: { borderColor: "var(--th-border)", background: "var(--th-card-bg)", color: "var(--th-text-secondary)" },
  };
}

export default function AlertFeed({
  title,
  alerts,
  emptyLabel,
  sourceLabel,
  updatedLabel,
  formatTime,
}: AlertFeedProps) {
  return (
    <section
      className="rounded-2xl border p-4"
      style={{ borderColor: "var(--border)", background: "var(--bg-surface-solid, #0f0f11)" }}
    >
      <header
        className="mb-3 flex items-center justify-between border-b pb-2"
        style={{ borderColor: "var(--th-border)" }}
      >
        <h2
          className="text-[9px] uppercase tracking-[0.05em]"
          style={{ fontFamily: "'Press Start 2P', monospace", color: "var(--text-primary, #e4e4e7)" }}
        >
          {title}
        </h2>
        <span
          className="rounded-full px-2 py-0.5 text-xs"
          style={{ background: "var(--border)", color: "var(--text-secondary, #a1a1aa)" }}
        >
          {alerts.length}
        </span>
      </header>

      {alerts.length <= 0 ? (
        <p
          className="rounded-xl border border-dashed px-4 py-6 text-center text-sm"
          style={{ borderColor: "var(--th-border)", color: "var(--th-text-secondary)" }}
        >
          {emptyLabel}
        </p>
      ) : (
        <div className="space-y-2">
          {alerts.map((alert) => {
            const ls = levelStyle(alert.level);
            return (
              <article key={alert.id} className={`rounded-xl border px-3 py-2.5 ${ls.className}`} style={ls.style}>
                <p className="text-sm font-medium">{alert.title}</p>
                <p className="mt-0.5 text-xs opacity-90">{alert.detail}</p>
                <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11px] opacity-80">
                  <span>
                    {sourceLabel}: {alert.source}
                  </span>
                  <span>
                    {updatedLabel}: {formatTime(alert.created_at)}
                  </span>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
