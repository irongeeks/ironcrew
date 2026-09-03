import { useEffect, useRef, type MutableRefObject } from "react";
import type { Application } from "pixi.js";
import { Container, Graphics, Sprite, Text } from "pixi.js";
import { resolveAgentCharacterIndex } from "../AgentAvatar";
import { loadCharWalkFrames, type AgentAnimState, type WalkFrames } from "./agentSprites";
import type { Agent } from "../../types";

export function useAgentLayer(
  agents: Agent[],
  loading: boolean,
  appRef: MutableRefObject<Application | null>,
  worldRef: MutableRefObject<Container | null>,
  agentLayerRef: MutableRefObject<Container | null>,
  agentSpritesRef: MutableRefObject<Map<string, Container>>,
  agentAnimRef: MutableRefObject<Map<string, AgentAnimState>>,
  onSelectAgentRef: MutableRefObject<(agent: Agent) => void>,
  getAgentTarget: (agent: Agent) => { x: number; y: number; seatDirection: import("./agentSprites").WalkDir | null },
) {
  // Generation counter to detect stale async callbacks after re-renders
  const generationRef = useRef(0);

  // ── SYNC AGENT SPRITES ──
  useEffect(() => {
    if (!appRef.current || loading) return;
    const world = worldRef.current;
    if (!world) return;

    const generation = ++generationRef.current;

    const loadAgentSprite = async (agent: Agent): Promise<void> => {
      if (agentSpritesRef.current.has(agent.id)) return;

      const agentCont = new Container();
      agentCont.label = agent.id;

      let walkFrames: WalkFrames | null = null;
      try {
        const charIdx = resolveAgentCharacterIndex(agent) ?? 0;
        walkFrames = await loadCharWalkFrames(charIdx);

        // Bail out if the effect has been superseded by a newer render
        if (generationRef.current !== generation) {
          agentCont.destroy({ children: true, texture: false });
          return;
        }

        const idleTex = walkFrames.down[1]; // idle = down row, middle frame
        const sprite = new Sprite(idleTex);
        sprite.label = "body";
        sprite.anchor.set(0.5, 0.9);
        sprite.texture.source.scaleMode = "nearest";
        sprite.width = 32;
        sprite.height = 52;
        agentCont.addChild(sprite);
      } catch {
        // Bail out if stale
        if (generationRef.current !== generation) {
          agentCont.destroy({ children: true, texture: false });
          return;
        }

        const fallback = new Graphics();
        fallback.label = "body";
        fallback.circle(0, -8, 6).fill(0x4ade80);
        agentCont.addChild(fallback);
      }

      // Name tag
      const nameText = new Text({
        text: agent.name.split(" ")[0].toUpperCase(),
        style: {
          fontFamily: '"Upheaval TT BRK", "Press Start 2P", monospace',
          fontSize: 12,
          fill: 0xffffff,
          stroke: { color: 0x000000, width: 2 },
        },
      });
      nameText.anchor.set(0.5, 0);
      nameText.y = 2;
      agentCont.addChild(nameText);

      // Status indicator dot
      const indicator = new Graphics();
      indicator.label = "indicator";
      indicator.circle(0, 0, 2.5).fill(0x4ade80);
      indicator.y = -22;
      agentCont.addChild(indicator);

      // Role badge for leaders
      if (agent.role === "team_leader") {
        const badge = new Text({
          text: "\u2605",
          style: { fontFamily: "monospace", fontSize: 12, fill: 0xfacc15 },
        });
        badge.anchor.set(0.5, 0.5);
        badge.x = 10;
        badge.y = -18;
        agentCont.addChild(badge);
      }

      agentCont.interactive = true;
      agentCont.cursor = "pointer";
      agentCont.on("pointerdown", () => onSelectAgentRef.current(agent));

      const startPos = getAgentTarget(agent);
      agentCont.x = startPos.x;
      agentCont.y = startPos.y;

      // Initialize animation state
      const defaultFrames: WalkFrames = { down: [], left: [], right: [], up: [] };
      agentAnimRef.current.set(agent.id, {
        frames: walkFrames ?? defaultFrames,
        path: [],
        pathIdx: 0,
        targetX: startPos.x,
        targetY: startPos.y,
        walkFrame: 0,
        walkTime: 0,
        direction: "down",
        wanderTarget: null,
        wanderTimer: Math.random() * 5000, // stagger initial wander so agents don't all move at once
        seatDirection: null,
      });

      const layer = agentLayerRef.current ?? world;
      layer.addChild(agentCont);
      agentSpritesRef.current.set(agent.id, agentCont);
    };

    // Track per-agent rejections so a single failure doesn't drop the whole batch
    // unobserved. We isolate failures per agent (so others still load) and log
    // any errors at the batch level.
    Promise.all(
      agents.map((agent) =>
        loadAgentSprite(agent).catch((err: unknown) => {
          console.error(`[useAgentLayer] failed to load sprite for agent ${agent.id}:`, err);
        }),
      ),
    ).catch((err: unknown) => {
      // Defensive: should be unreachable because per-agent catches above swallow rejections.
      console.error("[useAgentLayer] unexpected sprite-load batch failure:", err);
    });

    // Remove departed agents
    agentSpritesRef.current.forEach((sprite, id) => {
      if (!agents.find((a) => a.id === id)) {
        sprite.destroy({ children: true, texture: false });
        agentSpritesRef.current.delete(id);
        agentAnimRef.current.delete(id);
      }
    });
  }, [
    agents,
    loading,
    getAgentTarget,
    appRef,
    worldRef,
    agentLayerRef,
    agentSpritesRef,
    agentAnimRef,
    onSelectAgentRef,
  ]);
}
