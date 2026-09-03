import type { OperationsNode } from "../../types";

export interface NodeGridProps {
  title: string;
  nodes: OperationsNode[];
  emptyLabel: string;
  drainLabel: string;
  drainingLabel: string;
  capacityLabel: string;
  queueLabel: string;
  healthLabel: string;
  onDrain: (nodeId: string) => void;
  onEdit: (nodeId: string) => void;
  editLabel: string;
  busyNodeId: string | null;
  formatTime: (ts: number | null) => string;
}

function statusColor(status: string): string {
  if (status === "busy" || status === "online") return "text-emerald-300";
  if (status === "idle") return "text-sky-300";
  return "text-rose-300";
}

export default function NodeGrid({
  title,
  nodes,
  emptyLabel,
  drainLabel,
  drainingLabel,
  capacityLabel,
  queueLabel,
  healthLabel,
  onDrain,
  onEdit,
  editLabel,
  busyNodeId,
  formatTime,
}: NodeGridProps) {
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
          {nodes.length}
        </span>
      </header>

      {nodes.length <= 0 ? (
        <p
          className="rounded-xl border border-dashed px-4 py-6 text-center text-sm"
          style={{ borderColor: "var(--th-border)", color: "var(--th-text-secondary)" }}
        >
          {emptyLabel}
        </p>
      ) : (
        <div className="grid gap-2 lg:grid-cols-2">
          {nodes.map((node) => {
            const drainBusy = busyNodeId === node.id;
            return (
              <article
                key={node.id}
                className="rounded-xl border px-3 py-3"
                style={{ borderColor: "var(--th-border)", background: "var(--th-bg-secondary)" }}
              >
                <div className="mb-2 flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium" style={{ color: "var(--th-text-heading)" }}>
                      {node.name}
                    </p>
                    <p className="mt-0.5 text-xs" style={{ color: "var(--th-text-secondary)" }}>
                      {node.type}
                    </p>
                  </div>
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      onClick={() => onEdit(node.id)}
                      className="rounded-md border px-2 py-1 text-xs font-medium transition"
                      style={{
                        borderColor: "var(--border-strong)",
                        background: "var(--bg-surface-hover)",
                        color: "var(--text-primary, #e4e4e7)",
                      }}
                    >
                      {editLabel}
                    </button>
                    <button
                      type="button"
                      onClick={() => onDrain(node.id)}
                      disabled={drainBusy}
                      className="rounded-md border px-2 py-1 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-60"
                      style={{
                        borderColor: "var(--border-strong)",
                        background: "var(--bg-surface-hover)",
                        color: "var(--text-primary, #e4e4e7)",
                      }}
                    >
                      {drainBusy ? drainingLabel : drainLabel}
                    </button>
                  </div>
                </div>

                <div className="space-y-1 text-xs" style={{ color: "var(--th-text-secondary)" }}>
                  <p>
                    <span style={{ color: "var(--th-text-muted)" }}>{capacityLabel}:</span> {node.current_jobs} /{" "}
                    {node.max_concurrent_jobs} running
                  </p>
                  <p>
                    <span style={{ color: "var(--th-text-muted)" }}>{queueLabel}:</span> {node.queued_allocations}{" "}
                    waiting, {node.active_allocations} active
                  </p>
                  <p>
                    <span style={{ color: "var(--th-text-muted)" }}>status:</span>{" "}
                    <span className={statusColor(node.status)}>{node.status}</span>
                  </p>
                  <p className="truncate text-[11px]" style={{ color: "var(--th-text-muted)" }}>
                    {healthLabel}:{" "}
                    {node.last_health_error ? node.last_health_error : formatTime(node.last_health_check_at)}
                  </p>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
