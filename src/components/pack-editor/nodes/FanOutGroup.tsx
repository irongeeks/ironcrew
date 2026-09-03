import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { PhaseNodeData } from "../pack-deserializer";
import type { PhaseExecutionState } from "../execution-types";
import { OUTPUT_TYPE_COLORS } from "../types";

function humanize(name: string): string {
  return name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function FanOutGroup({ data, selected }: NodeProps) {
  const { phase } = data as unknown as PhaseNodeData;
  const exec = (data as Record<string, unknown>).executionState as PhaseExecutionState | undefined;

  return (
    <div
      className="rounded-lg p-2.5"
      style={{
        border: "1px dashed rgba(250,204,21,0.3)",
        background: "rgba(250,204,21,0.03)",
      }}
    >
      {/* Input handles */}
      {phase.inputs.map((input, i) => (
        <Handle
          key={`in-${input.name}`}
          type="target"
          position={Position.Left}
          id={`input-${input.name}`}
          style={{
            top: `${40 + i * 20}px`,
            width: 10,
            height: 10,
            background: "var(--accent)",
            border: "2px solid var(--bg-surface-solid)",
          }}
        />
      ))}

      {/* Fan-out label with execution progress */}
      <div className="mb-1.5 flex items-center gap-1.5 font-mono text-[9px]" style={{ color: "#facc15" }}>
        <span>fan-out</span>
        {exec?.totalInstances ? (
          <span
            className="rounded px-1 py-0.5"
            style={{
              background:
                exec.doneInstances === exec.totalInstances ? "rgba(125,211,168,0.15)" : "rgba(250,204,21,0.12)",
              color: exec.doneInstances === exec.totalInstances ? "var(--status-working)" : undefined,
            }}
          >
            {exec.doneInstances}/{exec.totalInstances}
          </span>
        ) : (
          <span className="rounded px-1 py-0.5" style={{ background: "rgba(250,204,21,0.12)" }}>
            ×N
          </span>
        )}
        {exec?.status === "in_progress" && (
          <span
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{ background: "var(--accent)", animation: "pulse-opacity 1.5s ease-in-out infinite" }}
          />
        )}
      </div>

      {/* Stacked card effect */}
      <div className="relative" style={{ height: 44, width: 200 }}>
        <div
          className="absolute rounded-md border"
          style={{
            left: 6,
            top: 6,
            width: 194,
            height: 36,
            background: "var(--bg-base)",
            borderColor: "rgba(250,204,21,0.1)",
          }}
        />
        <div
          className="absolute rounded-md border"
          style={{
            left: 3,
            top: 3,
            width: 197,
            height: 36,
            background: "var(--bg-surface-solid)",
            borderColor: "rgba(250,204,21,0.15)",
          }}
        />
        <div
          className="absolute flex items-center gap-2 rounded-md border px-2.5"
          style={{
            left: 0,
            top: 0,
            width: 200,
            height: 36,
            background: "var(--bg-surface-solid)",
            borderColor: selected ? "rgba(250,204,21,0.5)" : "rgba(250,204,21,0.25)",
            boxShadow: selected ? "0 0 8px rgba(250,204,21,0.15)" : "none",
          }}
        >
          <span className="text-[10px] font-semibold" style={{ color: "var(--text-primary)" }}>
            {humanize(phase.id)}
          </span>
          <span
            className="ml-auto rounded px-1.5 py-0.5 text-[9px]"
            style={{ background: "var(--bg-surface-hover)", color: "var(--text-secondary)" }}
          >
            {phase.department}
          </span>
        </div>
      </div>

      {/* Output handles */}
      {phase.outputs.map((output, i) => (
        <Handle
          key={`out-${output.name}`}
          type="source"
          position={Position.Right}
          id={`output-${output.name}`}
          style={{
            top: `${40 + i * 20}px`,
            width: 10,
            height: 10,
            background: OUTPUT_TYPE_COLORS[output.type] ?? "var(--accent)",
            border: "2px solid var(--bg-surface-solid)",
          }}
        />
      ))}
    </div>
  );
}
