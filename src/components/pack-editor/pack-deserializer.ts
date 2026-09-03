import dagre from "@dagrejs/dagre";
import type { Node, Edge } from "@xyflow/react";
import type { PackDefinitionResponse, PhaseDefinition, ValidationError } from "./types";

export interface PhaseNodeData {
  phase: PhaseDefinition;
  packKey: string;
  guidanceLanguages: string[];
  validationErrors?: ValidationError[];
}

const NODE_WIDTH = 220;
const NODE_HEIGHT = 100;

/**
 * Parse an input reference to extract source phase ID.
 * Input references follow the pattern: "phaseId.outputName" or "phaseId.outputName.path"
 */
function parseInputSource(from: string): { phaseId: string; outputName: string } {
  const parts = from.split(".");
  return { phaseId: parts[0], outputName: parts[1] ?? parts[0] };
}

/**
 * Apply dagre auto-layout to nodes and edges (top-to-bottom).
 */
function applyDagreLayout(nodes: Node[], edges: Edge[]): Node[] {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "TB", nodesep: 30, ranksep: 50 });

  for (const node of nodes) {
    g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  return nodes.map((node) => {
    const pos = g.node(node.id);
    return {
      ...node,
      position: {
        x: pos.x - NODE_WIDTH / 2,
        y: pos.y - NODE_HEIGHT / 2,
      },
    };
  });
}

/**
 * Determine the output type for an edge based on the source phase output.
 */
function resolveEdgeOutputType(phases: PhaseDefinition[], sourcePhaseId: string, outputName: string): string {
  const phase = phases.find((p) => p.id === sourcePhaseId);
  if (!phase) return "markdown";
  const output = phase.outputs.find((o) => o.name === outputName);
  return output?.type ?? "markdown";
}

/**
 * Convert a PackDefinitionResponse into React Flow nodes and edges with auto-layout.
 */
export function deserializePack(
  pack: PackDefinitionResponse,
  savedPositions?: Record<string, { x: number; y: number }> | null,
): { nodes: Node[]; edges: Edge[] } {
  const { definition, guidanceLanguages } = pack;
  const phases = definition.phases;

  // Create nodes
  const nodes: Node[] = phases.map((phase) => ({
    id: phase.id,
    type: phase.fan_out ? "fanOutGroup" : "phaseNode",
    position: { x: 0, y: 0 },
    data: {
      phase,
      packKey: pack.key,
      guidanceLanguages: guidanceLanguages[phase.id] ?? [],
    } satisfies PhaseNodeData,
  }));

  // Create edges from input references
  const edges: Edge[] = [];
  for (const phase of phases) {
    for (const input of phase.inputs) {
      const { phaseId: sourcePhaseId, outputName } = parseInputSource(input.from);
      if (phases.some((p) => p.id === sourcePhaseId)) {
        const outputType = resolveEdgeOutputType(phases, sourcePhaseId, outputName);
        edges.push({
          id: `${sourcePhaseId}-${outputName}-to-${phase.id}-${input.name}`,
          source: sourcePhaseId,
          target: phase.id,
          sourceHandle: `output-${outputName}`,
          targetHandle: `input-${input.name}`,
          type: "artifactEdge",
          data: { outputType, from: input.from },
        });
      }
    }
  }

  // Use saved positions if available, otherwise auto-layout with dagre
  if (savedPositions && Object.keys(savedPositions).length > 0) {
    const layoutedNodes = nodes.map((node) => ({
      ...node,
      position: savedPositions[node.id] ?? { x: 0, y: 0 },
    }));
    return { nodes: layoutedNodes, edges };
  }

  const layoutedNodes = applyDagreLayout(nodes, edges);
  return { nodes: layoutedNodes, edges };
}
