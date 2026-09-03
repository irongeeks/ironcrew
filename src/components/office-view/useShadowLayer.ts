import { useEffect, useRef, type MutableRefObject } from "react";
import { Graphics, GraphicsContext, type Container } from "pixi.js";
import type { Agent } from "../../types";
import type { AgentAnimState } from "./agentSprites";

/** Shared geometry for drop shadows — one definition, N instances */
const shadowCtx = new GraphicsContext().ellipse(0, 0, 14, 3.5).fill({ color: 0x000000, alpha: 0.25 });

/** Shared geometry for lamp light pools */
const lampCtx = new GraphicsContext().ellipse(0, 0, 40, 28).fill({ color: 0xffdc96, alpha: 0.08 });

/** Direction-based offset to shift lamp toward the desk */
const LAMP_OFFSET: Record<string, { x: number; y: number }> = {
  up: { x: 0, y: -20 },
  down: { x: 0, y: 20 },
  left: { x: -20, y: 0 },
  right: { x: 20, y: 0 },
};

export function useShadowLayer(
  loading: boolean,
  shadowLayerRef: MutableRefObject<Container | null>,
  agentSpritesRef: MutableRefObject<Map<string, Container>>,
  agentAnimRef: MutableRefObject<Map<string, AgentAnimState>>,
  agentsRef: MutableRefObject<Agent[]>,
) {
  // Track created shadow/lamp Graphics per agent id
  const shadowsRef = useRef(new Map<string, Graphics>());
  const lampsRef = useRef(new Map<string, Graphics>());

  useEffect(() => {
    if (loading) return;
    const shadows = shadowsRef.current;
    const lamps = lampsRef.current;
    return () => {
      // Destroy all shadows/lamps on unmount
      shadows.forEach((s) => s.destroy());
      shadows.clear();
      lamps.forEach((l) => l.destroy());
      lamps.clear();
    };
  }, [loading]);

  /** Call this from the ticker to sync shadow positions */
  function updateShadows() {
    const layer = shadowLayerRef.current;
    if (!layer) return;

    // Sync shadows with current agent sprites
    // Create shadows for agents that don't have one yet
    agentSpritesRef.current.forEach((_, id) => {
      if (!shadowsRef.current.has(id)) {
        const shadow = new Graphics(shadowCtx);
        layer.addChild(shadow);
        shadowsRef.current.set(id, shadow);
      }
      if (!lampsRef.current.has(id)) {
        const lamp = new Graphics(lampCtx);
        lamp.blendMode = "add";
        lamp.alpha = 0;
        layer.addChild(lamp);
        lampsRef.current.set(id, lamp);
      }
    });

    // Remove shadows for agents no longer in agentSpritesRef
    for (const [id, shadow] of shadowsRef.current) {
      if (!agentSpritesRef.current.has(id)) {
        shadow.destroy();
        shadowsRef.current.delete(id);
      }
    }
    for (const [id, lamp] of lampsRef.current) {
      if (!agentSpritesRef.current.has(id)) {
        lamp.destroy();
        lampsRef.current.delete(id);
      }
    }

    // Update positions and alpha for all current agents
    agentSpritesRef.current.forEach((sprite, id) => {
      const agent = agentsRef.current.find((a) => a.id === id);
      if (!agent) return;
      const anim = agentAnimRef.current.get(id);

      // Drop shadow
      const shadow = shadowsRef.current.get(id);
      if (shadow) {
        shadow.x = sprite.x;
        shadow.y = sprite.y + 4;
        const isSeated = anim != null && anim.seatDirection !== null;
        shadow.scale.set(isSeated ? 0.8 : 1);
      }

      // Lamp light pool
      const lamp = lampsRef.current.get(id);
      if (lamp) {
        const isSeated = anim != null && anim.seatDirection !== null;
        const isWorking = agent.status === "working";
        const targetAlpha = isSeated && isWorking ? 0.08 : 0;

        // Smooth fade
        lamp.alpha += (targetAlpha - lamp.alpha) * 0.02;
        if (lamp.alpha < 0.001) lamp.alpha = 0;

        // Subtle pulse when on
        if (lamp.alpha > 0.01) {
          lamp.alpha = Math.max(0, lamp.alpha + Math.sin(Date.now() * 0.003) * 0.01);
        }

        // Position at seat with offset toward desk
        lamp.x = sprite.x;
        lamp.y = sprite.y;
        if (anim?.seatDirection) {
          const offset = LAMP_OFFSET[anim.seatDirection] ?? { x: 0, y: 0 };
          lamp.x += offset.x;
          lamp.y += offset.y;
        }
      }
    });
  }

  return { updateShadows };
}
