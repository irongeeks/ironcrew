import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  BackgroundVariant,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type NodeTypes,
  type EdgeTypes,
  type Connection,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./graph-overrides.css";
import { PhaseNode } from "./nodes/PhaseNode";
import { FanOutGroup } from "./nodes/FanOutGroup";
import { ArtifactEdge } from "./edges/ArtifactEdge";
import { deserializePack } from "./pack-deserializer";
import { fetchPackDefinition, fetchPackPositions, savePackPositions } from "../../api/workflow-packs";
import { useMobile } from "../../hooks/useMobile";
import type { PackDefinitionResponse, ValidationError } from "./types";
import type { ExecutionState } from "./execution-types";

const nodeTypes: NodeTypes = {
  phaseNode: PhaseNode,
  fanOutGroup: FanOutGroup,
};

const edgeTypes: EdgeTypes = {
  artifactEdge: ArtifactEdge,
};

interface GraphCanvasProps {
  packKey: string;
  executionState?: ExecutionState | null;
  validationErrors?: Map<string, ValidationError[]>;
  editorMode?: boolean;
  /** When provided, render these phases instead of fetching from API (used in edit mode). */
  editorPhases?: import("./types").PhaseDefinition[];
  onNodeSelect?: (nodeId: string | null) => void;
  onConnect?: (sourcePhaseId: string, outputName: string, targetPhaseId: string, inputName: string) => void;
}

export function GraphCanvas({
  packKey,
  executionState,
  validationErrors,
  editorMode,
  editorPhases,
  onNodeSelect,
  onConnect,
}: GraphCanvasProps) {
  const { isMobile } = useMobile();
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadPack = useCallback(
    async (key: string) => {
      setLoading(true);
      setError(null);
      try {
        const [packData, positions] = await Promise.all([fetchPackDefinition(key), fetchPackPositions(key)]);
        const pack = packData as unknown as PackDefinitionResponse;
        const { nodes: newNodes, edges: newEdges } = deserializePack(pack, positions);
        setNodes(newNodes);
        setEdges(newEdges);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [setNodes, setEdges],
  );

  // In edit mode, rebuild nodes/edges from editor state; otherwise fetch from API
  useEffect(() => {
    if (editorPhases) {
      // Build a synthetic PackDefinitionResponse from editor phases
      const syntheticPack: PackDefinitionResponse = {
        key: packKey,
        source: "community",
        definition: {
          pack: { key: packKey, name: { en: packKey }, version: "1.0.0", schema_version: 1, description: { en: "" } },
          input: { required: [], optional: [] },
          phases: editorPhases,
        },
        guidanceLanguages: {},
      };
      fetchPackPositions(packKey)
        .then((positions) => {
          const { nodes: newNodes, edges: newEdges } = deserializePack(syntheticPack, positions);
          setNodes(newNodes);
          setEdges(newEdges);
          setLoading(false);
        })
        .catch(() => {
          const { nodes: newNodes, edges: newEdges } = deserializePack(syntheticPack, null);
          setNodes(newNodes);
          setEdges(newEdges);
          setLoading(false);
        });
      return;
    }
    void loadPack(packKey);
  }, [packKey, loadPack, editorPhases, setNodes, setEdges]);

  const onNodeDragStop = useCallback(() => {
    const posMap: Record<string, { x: number; y: number }> = {};
    for (const node of nodes) {
      posMap[node.id] = node.position;
    }
    void savePackPositions(packKey, posMap);
  }, [nodes, packKey]);

  // Handle node selection
  const handleNodeClick = useCallback(
    (_: unknown, node: Node) => {
      onNodeSelect?.(node.id);
    },
    [onNodeSelect],
  );

  const handlePaneClick = useCallback(() => {
    onNodeSelect?.(null);
  }, [onNodeSelect]);

  // Handle new connections in editor mode
  const handleConnect = useCallback(
    (connection: Connection) => {
      if (!onConnect || !connection.sourceHandle || !connection.targetHandle) return;
      const outputName = connection.sourceHandle.replace("output-", "");
      const inputName = connection.targetHandle.replace("input-", "");
      onConnect(connection.source, outputName, connection.target, inputName);
    },
    [onConnect],
  );

  // Inject execution state and validation errors into node data
  const nodesWithState = useMemo(() => {
    let result = nodes;
    if (executionState) {
      result = result.map((node) => {
        const phaseExec = executionState.phases.get(node.id);
        if (!phaseExec) return node;
        return { ...node, data: { ...node.data, executionState: phaseExec } };
      });
    }
    if (validationErrors) {
      result = result.map((node) => {
        const errors = validationErrors.get(node.id);
        if (!errors || errors.length === 0) return node;
        return { ...node, data: { ...node.data, validationErrors: errors } };
      });
    }
    return result;
  }, [nodes, executionState, validationErrors]);

  const edgesWithExecution = useMemo(() => {
    if (!executionState) return edges;
    return edges.map((edge) => {
      const sourcePhase = executionState.phases.get(edge.source);
      if (!sourcePhase) return edge;
      return { ...edge, data: { ...edge.data, sourcePhaseStatus: sourcePhase.status } };
    });
  }, [edges, executionState]);

  if (isMobile) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <span className="text-4xl">🖥️</span>
        <h2 className="text-sm font-bold" style={{ color: "var(--th-text-primary)" }}>
          Pack Editor ist auf Desktop verfügbar
        </h2>
        <p className="text-xs" style={{ color: "var(--th-text-secondary)" }}>
          Der visuelle Editor benötigt einen größeren Bildschirm. Bitte nutze ein Desktop-Gerät.
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center" style={{ color: "var(--text-muted)" }}>
        <span className="text-xs font-mono">Loading graph...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="text-xs text-red-400">{error}</span>
      </div>
    );
  }

  return (
    <ReactFlow
      nodes={nodesWithState}
      edges={edgesWithExecution}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeDragStop={onNodeDragStop}
      onNodeClick={handleNodeClick}
      onPaneClick={handlePaneClick}
      onConnect={editorMode ? handleConnect : undefined}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      fitView
      fitViewOptions={{ padding: 0.08 }}
      nodesDraggable={true}
      nodesConnectable={!!editorMode}
      elementsSelectable={true}
      minZoom={0.15}
      maxZoom={2}
      defaultEdgeOptions={{ animated: false }}
    >
      <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--border)" />
      <Controls
        showInteractive={false}
        position="bottom-left"
        style={{
          background: "var(--bg-surface-solid)",
          border: "1px solid var(--border-strong)",
          borderRadius: 8,
        }}
      />
      <MiniMap
        nodeColor={() => "var(--accent)"}
        maskColor="rgba(30,30,30,0.75)"
        position="top-right"
        style={{
          background: "var(--bg-surface-solid)",
          border: "1px solid var(--border-strong)",
          borderRadius: 8,
        }}
      />
    </ReactFlow>
  );
}
