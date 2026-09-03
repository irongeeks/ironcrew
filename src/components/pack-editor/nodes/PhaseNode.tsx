import React from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { PhaseNodeData } from "../pack-deserializer";
import type { PhaseExecutionState } from "../execution-types";
import { OUTPUT_TYPE_COLORS, type ValidationError } from "../types";

function humanize(name: string): string {
  return name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

const TYPE_ICONS: Record<string, string> = {
  json: "{ }",
  markdown: "doc",
  image: "img",
  video: "vid",
  audio: "aud",
  document: "doc",
};

const HEADER_HEIGHT = 28;
const PORT_SPACING = 18;

const STATUS_BORDER: Record<string, string> = {
  pending: "var(--border-strong)",
  blocked: "var(--border)",
  in_progress: "var(--accent)",
  done: "var(--status-working)",
  skipped: "var(--border)",
  awaiting_approval: "#facc15",
};

const STATUS_GLOW: Record<string, string> = {
  in_progress: "0 0 12px var(--accent-glow)",
  done: "0 0 8px var(--status-working-glow)",
  awaiting_approval: "0 0 8px rgba(250,204,21,0.2)",
};

function StatusBadge({ exec }: { exec?: PhaseExecutionState }) {
  if (!exec || exec.status === "pending" || exec.status === "blocked") return null;

  const labels: Record<string, string> = {
    in_progress: "Running...",
    done: "Done",
    skipped: "Skipped",
    awaiting_approval: "Awaiting Approval",
  };

  const colors: Record<string, string> = {
    in_progress: "var(--accent)",
    done: "var(--status-working)",
    skipped: "var(--text-muted)",
    awaiting_approval: "#facc15",
  };

  return (
    <span
      className="rounded px-1 py-0.5 text-[7px] font-medium"
      style={{
        background: `color-mix(in srgb, ${colors[exec.status] ?? "var(--text-muted)"} 15%, transparent)`,
        color: colors[exec.status] ?? "var(--text-muted)",
        animation: exec.status === "in_progress" ? "pulse-opacity 1.5s ease-in-out infinite" : undefined,
      }}
    >
      {labels[exec.status] ?? exec.status}
    </span>
  );
}

export const PhaseNode = React.memo(function PhaseNode({ data, selected }: NodeProps) {
  const { phase } = data as unknown as PhaseNodeData;
  const exec = (data as Record<string, unknown>).executionState as PhaseExecutionState | undefined;
  const validationErrors = (data as Record<string, unknown>).validationErrors as ValidationError[] | undefined;
  const hasErrors = validationErrors && validationErrors.length > 0;

  const isNodeTypePhase = !!phase.node_type;
  const isConnectorPhase = phase.capability_mode === "server";
  const isAgentPhase = !phase.capability || phase.capability_mode === "agent";
  const requiresApproval = phase.gate === "user_approval";

  const inputCount = phase.inputs.length;
  const outputCount = phase.outputs.length;
  const maxPorts = Math.max(inputCount, outputCount, 1);
  const hasTags = phase.capability || phase.skip_when || isNodeTypePhase;
  const tagsHeight = hasTags && !exec ? 20 : 0;
  const portsHeight = maxPorts * PORT_SPACING + 8;
  const totalHeight = HEADER_HEIGHT + tagsHeight + portsHeight + 4;

  // Node type color could come from external data; for now we use a default per category
  const nodeTypeColor: string | undefined = undefined;

  const borderColor = hasErrors
    ? "#ef4444"
    : exec
      ? (STATUS_BORDER[exec.status] ?? "var(--border-strong)")
      : selected
        ? "var(--accent)"
        : isNodeTypePhase
          ? `color-mix(in srgb, ${nodeTypeColor ?? "var(--accent)"} 40%, transparent)`
          : isConnectorPhase
            ? "rgba(100, 200, 120, 0.35)"
            : requiresApproval
              ? "rgba(250, 204, 21, 0.25)"
              : "var(--border-strong)";

  const boxShadow = hasErrors
    ? "0 0 12px rgba(239,68,68,0.3)"
    : exec
      ? (STATUS_GLOW[exec.status] ?? "0 2px 8px rgba(0,0,0,0.3)")
      : selected
        ? "0 0 12px var(--accent-glow)"
        : "0 2px 8px rgba(0,0,0,0.3)";

  const opacity = exec?.status === "skipped" ? 0.4 : exec?.status === "blocked" || exec?.status === "pending" ? 0.6 : 1;

  return (
    <div
      className="overflow-visible rounded-lg border transition-all"
      style={{
        background: "var(--bg-surface-solid)",
        borderColor,
        boxShadow,
        width: 220,
        height: totalHeight,
        opacity,
      }}
    >
      {/* Input handles + labels */}
      {phase.inputs.map((input, i) => {
        const top = HEADER_HEIGHT + tagsHeight + 8 + i * PORT_SPACING;
        return (
          <div key={`in-${input.name}`}>
            <Handle
              type="target"
              position={Position.Left}
              id={`input-${input.name}`}
              style={{
                top,
                width: 8,
                height: 8,
                background: "var(--accent)",
                border: "2px solid var(--bg-surface-solid)",
              }}
            />
            <div
              className="absolute text-[8px] leading-none"
              style={{ top: top - 4, left: 10, color: "var(--text-muted)" }}
            >
              {humanize(input.name)}
            </div>
          </div>
        );
      })}

      {/* Output handles + labels */}
      {phase.outputs.map((output, i) => {
        const top = HEADER_HEIGHT + tagsHeight + 8 + i * PORT_SPACING;
        const color = OUTPUT_TYPE_COLORS[output.type] ?? "var(--accent)";
        return (
          <div key={`out-${output.name}`}>
            <Handle
              type="source"
              position={Position.Right}
              id={`output-${output.name}`}
              style={{
                top,
                width: 8,
                height: 8,
                background: color,
                border: "2px solid var(--bg-surface-solid)",
              }}
            />
            <div
              className="absolute flex items-center gap-1 text-[8px] leading-none"
              style={{ top: top - 4, right: 10, color: "var(--text-muted)" }}
            >
              {humanize(output.name)}
              <span style={{ color: "var(--text-dim)", fontSize: 7 }}>{TYPE_ICONS[output.type] ?? output.type}</span>
            </div>
          </div>
        );
      })}

      {/* Header */}
      <div
        className="flex items-center gap-1.5 px-2.5"
        style={{
          height: HEADER_HEIGHT,
          background: isConnectorPhase ? "rgba(40, 80, 50, 0.5)" : "var(--accent-dim)",
          borderBottom: `1px solid ${isConnectorPhase ? "rgba(100, 200, 120, 0.2)" : "var(--border)"}`,
          borderRadius: "7px 7px 0 0",
        }}
      >
        {exec?.status === "done" && <span style={{ color: "var(--status-working)", fontSize: 10 }}>✓</span>}
        {exec?.status === "in_progress" && (
          <span
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{ background: "var(--accent)", animation: "pulse-opacity 1.5s ease-in-out infinite" }}
          />
        )}
        {exec?.status === "skipped" && <span style={{ color: "var(--text-muted)", fontSize: 9 }}>⊘</span>}
        {exec?.status === "awaiting_approval" && <span style={{ color: "#facc15", fontSize: 9 }}>⏸</span>}
        {isNodeTypePhase && !exec && <span style={{ fontSize: 10 }}>🧩</span>}
        {!isNodeTypePhase && isConnectorPhase && !exec && <span style={{ fontSize: 10 }}>⚡</span>}
        {!isNodeTypePhase && isAgentPhase && !exec && <span style={{ fontSize: 9, opacity: 0.5 }}>🤖</span>}
        <span
          className="text-[10px] font-semibold"
          style={{
            color: isConnectorPhase ? "#88ee99" : "var(--text-primary)",
            textDecoration: exec?.status === "skipped" ? "line-through" : undefined,
          }}
        >
          {humanize(phase.id)}
        </span>
        <StatusBadge exec={exec} />
        {hasErrors && (
          <span
            className="rounded px-1 py-0.5 text-[7px] font-semibold"
            style={{
              background: "rgba(239, 68, 68, 0.15)",
              color: "#ef4444",
              border: "1px solid rgba(239, 68, 68, 0.3)",
            }}
            title={validationErrors!.map((e) => e.message).join("\n")}
          >
            {validationErrors!.length} error{validationErrors!.length > 1 ? "s" : ""}
          </span>
        )}
        {requiresApproval && (
          <span
            className="rounded px-1 py-0.5 text-[7px] font-semibold"
            style={{
              background: exec?.status === "awaiting_approval" ? "rgba(250, 204, 21, 0.25)" : "rgba(250, 204, 21, 0.1)",
              color: "#facc15",
              border: "1px solid rgba(250, 204, 21, 0.3)",
            }}
            title="Human approval required before next phase"
          >
            ✋ Approval
          </span>
        )}
        <span
          className="ml-auto rounded px-1 py-0.5 text-[8px] font-medium"
          style={{ background: "var(--bg-surface-hover)", color: "var(--text-secondary)" }}
        >
          {phase.department}
        </span>
      </div>

      {/* Tags (hidden during execution) */}
      {hasTags && !exec && (
        <div className="flex flex-wrap gap-1 px-2.5 py-1">
          {isNodeTypePhase && (
            <span
              className="rounded px-1 py-0.5 text-[7px]"
              style={{
                background: `color-mix(in srgb, ${nodeTypeColor ?? "var(--accent)"} 15%, transparent)`,
                color: nodeTypeColor ?? "var(--accent)",
              }}
            >
              🧩 {humanize(phase.node_type!)}
            </span>
          )}
          {phase.capability && (
            <span
              className="rounded px-1 py-0.5 text-[7px]"
              style={{
                background: isConnectorPhase ? "rgba(40, 120, 60, 0.2)" : "var(--accent-subtle)",
                color: isConnectorPhase ? "#88ee99" : "var(--accent)",
              }}
            >
              {isConnectorPhase ? "⚡ " : ""}
              {humanize(phase.capability)}
              {phase.capability_mode ? ` (${phase.capability_mode})` : ""}
            </span>
          )}
          {phase.skip_when && (
            <span
              className="rounded px-1 py-0.5 text-[7px]"
              style={{ background: "var(--bg-surface-hover)", color: "var(--text-muted)" }}
            >
              Conditional
            </span>
          )}
        </div>
      )}
    </div>
  );
});
