import { BaseEdge, getBezierPath, type EdgeProps } from "@xyflow/react";
import { OUTPUT_TYPE_COLORS } from "../types";

export function ArtifactEdge(props: EdgeProps) {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd } = props;

  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  const outputType = (data as { outputType?: string })?.outputType ?? "markdown";
  const sourceStatus = (data as { sourcePhaseStatus?: string })?.sourcePhaseStatus;
  const color = OUTPUT_TYPE_COLORS[outputType] ?? "#60a5fa";
  const isActive = sourceStatus === "in_progress";
  const isDone = sourceStatus === "done";

  return (
    <BaseEdge
      path={edgePath}
      markerEnd={markerEnd}
      style={{
        stroke: isDone ? "var(--status-working)" : color,
        strokeWidth: isActive ? 2 : 1.5,
        strokeOpacity: isDone ? 0.5 : isActive ? 0.8 : 0.4,
        strokeDasharray: isActive ? "6 3" : undefined,
        animation: isActive ? "dash-flow 0.8s linear infinite" : undefined,
      }}
    />
  );
}
