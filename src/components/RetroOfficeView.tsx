import { useCallback, useRef, useState } from "react";
import { type Application, type Container } from "pixi.js";
import type { TiledObject } from "./office-view/TiledRenderer";
import type { Agent, Department, ServerAllocation, ServerNode } from "../types";
import type { AgentAnimState } from "./office-view/agentSprites";
import { useAgentPositions } from "./office-view/useAgentPositions";
import { usePixiApp } from "./office-view/usePixiApp";
import { useAgentLayer } from "./office-view/useAgentLayer";
import { useServerLayer } from "./office-view/useServerLayer";
import { useShadowLayer } from "./office-view/useShadowLayer";
import { useParticleLayer } from "./office-view/useParticleLayer";
import type { RenderTier } from "./office-view/render-quality";

interface RetroOfficeViewProps {
  agents: Agent[];
  departments: Department[];
  servers: ServerNode[];
  serverAllocations: ServerAllocation[];
  onSelectAgent: (agent: Agent) => void;
  onSelectServer: (server: ServerNode | null) => void;
  onSelectDepartment: (dept: Department) => void;
}

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2.0;
const DEFAULT_ZOOM = 0.7;
const MOBILE_BREAKPOINT = 768;

export default function RetroOfficeView({
  agents,
  departments,
  servers,
  serverAllocations,
  onSelectAgent,
  onSelectServer,
  onSelectDepartment,
}: RetroOfficeViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<Application | null>(null);
  const worldRef = useRef<Container | null>(null);
  const agentLayerRef = useRef<Container | null>(null);
  const shadowLayerRef = useRef<Container | null>(null);
  const particleLayerRef = useRef<Container | null>(null);
  const agentSpritesRef = useRef<Map<string, Container>>(new Map());
  const agentAnimRef = useRef<Map<string, AgentAnimState>>(new Map());
  const collisionGridRef = useRef<Uint8Array | null>(null);
  const mapDimsRef = useRef<{ w: number; h: number }>({ w: 50, h: 30 });
  const mapPixelRef = useRef<{ w: number; h: number }>({ w: 800, h: 480 });
  const serverSpritesRef = useRef<Map<string, Container>>(new Map());
  const serverSlotsRef = useRef<Array<{ x: number; y: number; name: string }>>([]);
  const objectsRef = useRef<TiledObject[]>([]);
  const [loading, setLoading] = useState(true);
  // What the office settled on, and why. A scene that quietly halved its own
  // quality — or one that cannot run in this browser at all — is something
  // the operator has to be told, not left to infer from a blank rectangle.
  const [renderTier, setRenderTier] = useState<{ tier: RenderTier; reason: string }>({ tier: "high", reason: "" });
  const handleRenderTier = useCallback((tier: RenderTier, reason: string) => {
    setRenderTier({ tier, reason });
  }, []);
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  // Refs so ticker/effects always see latest data without re-init
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  const departmentsRef = useRef(departments);
  departmentsRef.current = departments;
  const serversRef = useRef(servers);
  serversRef.current = servers;
  const serverAllocationsRef = useRef(serverAllocations);
  serverAllocationsRef.current = serverAllocations;
  const onSelectAgentRef = useRef(onSelectAgent);
  onSelectAgentRef.current = onSelectAgent;
  const onSelectServerRef = useRef(onSelectServer);
  onSelectServerRef.current = onSelectServer;
  const onSelectDepartmentRef = useRef(onSelectDepartment);
  onSelectDepartmentRef.current = onSelectDepartment;

  // Hook calls in order
  const { getAgentTarget } = useAgentPositions(objectsRef, departmentsRef, agentAnimRef, collisionGridRef, mapDimsRef);

  const { updateShadows } = useShadowLayer(loading, shadowLayerRef, agentSpritesRef, agentAnimRef, agentsRef);
  const updateShadowsRef = useRef(updateShadows);
  updateShadowsRef.current = updateShadows;

  const { updateParticles } = useParticleLayer(
    loading,
    particleLayerRef,
    agentSpritesRef,
    agentAnimRef,
    agentsRef,
    mapPixelRef,
  );
  const updateParticlesRef = useRef(updateParticles);
  updateParticlesRef.current = updateParticles;

  usePixiApp(
    containerRef,
    appRef,
    worldRef,
    agentLayerRef,
    agentSpritesRef,
    agentAnimRef,
    collisionGridRef,
    mapDimsRef,
    mapPixelRef,
    serverSpritesRef,
    serverSlotsRef,
    objectsRef,
    zoomRef,
    setZoom,
    setLoading,
    agentsRef,
    departmentsRef,
    serversRef,
    serverAllocationsRef,
    onSelectAgentRef,
    onSelectServerRef,
    onSelectDepartmentRef,
    getAgentTarget,
    shadowLayerRef,
    updateShadowsRef,
    particleLayerRef,
    updateParticlesRef,
    handleRenderTier,
  );

  useAgentLayer(
    agents,
    loading,
    appRef,
    worldRef,
    agentLayerRef,
    agentSpritesRef,
    agentAnimRef,
    onSelectAgentRef,
    getAgentTarget,
  );

  useServerLayer(servers, serverAllocations, loading, appRef, worldRef, serverSpritesRef, serverSlotsRef);

  return (
    <div className="w-full h-full relative" style={{ background: "var(--bg-base)" }}>
      {renderTier.tier === "none" && !loading && (
        <div
          className="absolute inset-0 flex items-center justify-center z-10 p-6 text-center"
          style={{ background: "var(--bg-base)" }}
          data-testid="office-unavailable"
        >
          <div className="max-w-sm">
            <p className="text-xs font-pixel mb-2" style={{ color: "var(--text-secondary)" }}>
              OFFICE-ANSICHT NICHT VERFÜGBAR
            </p>
            <p className="text-[11px] font-mono leading-relaxed" style={{ color: "var(--text-muted)" }}>
              {renderTier.reason}
            </p>
            <p className="text-[11px] font-mono leading-relaxed mt-2" style={{ color: "var(--text-muted)" }}>
              Alle Funktionen bleiben über die Listen- und Kanban-Ansichten erreichbar.
            </p>
          </div>
        </div>
      )}

      {renderTier.reason !== "" && renderTier.tier !== "none" && (
        <div
          className="absolute top-2 left-2 z-10 px-2 py-1 rounded text-[10px] font-mono"
          style={{ background: "var(--bg-base)", color: "var(--text-muted)" }}
          data-testid="office-quality-notice"
        >
          {renderTier.reason}
        </div>
      )}

      {loading && (
        <div
          className="absolute inset-0 flex items-center justify-center z-10"
          style={{ background: "var(--bg-base)" }}
        >
          <span className="text-xs font-pixel animate-pulse" style={{ color: "var(--text-muted)" }}>
            LOADING OFFICE...
          </span>
        </div>
      )}

      <div
        ref={containerRef}
        role="img"
        aria-label="Pixel-art office view. Use the agent sidebar or the visually-hidden department list below for keyboard navigation."
        className="w-full h-full overflow-hidden flex items-center justify-center"
      />

      {/*
       * Accessible alternative for the Pixi canvas (E-006, #64).
       * Mirrors the canvas's clickable team areas as a visually-hidden DOM
       * twin so screen-reader and keyboard users can select departments.
       */}
      <ul className="sr-only-focusable" aria-label="Departments">
        {departments.map((dept) => (
          <li key={dept.id}>
            <button type="button" onClick={() => onSelectDepartment(dept)}>
              {dept.name}
            </button>
          </li>
        ))}
      </ul>

      {/* Floating zoom pill — bottom center, above canvas */}
      <div
        className="absolute bottom-4 left-1/2 flex items-center gap-2 px-4 py-2 rounded-full transition-opacity duration-200"
        style={{
          transform: "translateX(-50%)",
          zIndex: 30,
          background: "rgba(24, 24, 48, 0.85)",
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
          border: "1px solid var(--border-strong)",
        }}
      >
        <button
          className="min-h-[44px] min-w-[44px] flex items-center justify-center text-sm font-mono rounded-full active:scale-95 transition-transform"
          style={{ color: "var(--text-secondary)" }}
          onClick={() => {
            const newZoom = Math.max(MIN_ZOOM, Math.round((zoom - 0.1) * 10) / 10);
            setZoom(newZoom);
            zoomRef.current = newZoom;
            const isMobile = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`).matches;
            if (!isMobile && worldRef.current && appRef.current) {
              const { w: mw, h: mh } = mapPixelRef.current;
              worldRef.current.scale.set(newZoom);
              worldRef.current.position.set(0, 0);
              appRef.current.renderer.resize(Math.round(mw * newZoom), Math.round(mh * newZoom));
            }
          }}
          aria-label="Zoom out"
        >
          -
        </button>
        <input
          type="range"
          min={MIN_ZOOM}
          max={MAX_ZOOM}
          step={0.1}
          value={zoom}
          onChange={(e) => {
            const newZoom = parseFloat(e.target.value);
            setZoom(newZoom);
            zoomRef.current = newZoom;
            const isMobile = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`).matches;
            if (!isMobile && worldRef.current && appRef.current) {
              const { w: mw, h: mh } = mapPixelRef.current;
              worldRef.current.scale.set(newZoom);
              worldRef.current.position.set(0, 0);
              appRef.current.renderer.resize(Math.round(mw * newZoom), Math.round(mh * newZoom));
            }
          }}
          className="w-32 h-1 rounded-lg appearance-none cursor-pointer accent-retro-green"
          style={{ background: "var(--status-idle)" }}
        />
        <button
          className="min-h-[44px] min-w-[44px] flex items-center justify-center text-sm font-mono rounded-full active:scale-95 transition-transform"
          style={{ color: "var(--text-secondary)" }}
          onClick={() => {
            const newZoom = Math.min(MAX_ZOOM, Math.round((zoom + 0.1) * 10) / 10);
            setZoom(newZoom);
            zoomRef.current = newZoom;
            const isMobile = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`).matches;
            if (!isMobile && worldRef.current && appRef.current) {
              const { w: mw, h: mh } = mapPixelRef.current;
              worldRef.current.scale.set(newZoom);
              worldRef.current.position.set(0, 0);
              appRef.current.renderer.resize(Math.round(mw * newZoom), Math.round(mh * newZoom));
            }
          }}
          aria-label="Zoom in"
        >
          +
        </button>
        <span
          className="text-[10px] font-mono tabular-nums"
          style={{ color: "var(--text-secondary)", width: 28, textAlign: "right" }}
        >
          {zoom.toFixed(1)}x
        </span>
      </div>
    </div>
  );
}
