import { useEffect, useRef, type MutableRefObject } from "react";
import { Graphics, type Container } from "pixi.js";
import type { Agent } from "../../types";
import type { AgentAnimState } from "./agentSprites";

interface ActiveParticle {
  graphics: Graphics;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  type: "dust" | "steam" | "spark";
}

const MAX_PARTICLES = 60;
const DUST_COUNT = 25;
const SPARK_INTERVAL_MIN = 2000;
const SPARK_INTERVAL_MAX = 4000;

export function useParticleLayer(
  loading: boolean,
  particleLayerRef: MutableRefObject<Container | null>,
  agentSpritesRef: MutableRefObject<Map<string, Container>>,
  agentAnimRef: MutableRefObject<Map<string, AgentAnimState>>,
  agentsRef: MutableRefObject<Agent[]>,
  mapPixelRef: MutableRefObject<{ w: number; h: number }>,
) {
  const particlesRef = useRef<ActiveParticle[]>([]);
  const sparkTimersRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    if (loading) return;
    const layer = particleLayerRef.current;
    if (!layer) return;

    // Seed initial dust particles
    const { w: mapW, h: mapH } = mapPixelRef.current;
    for (let i = 0; i < DUST_COUNT; i++) {
      spawnDust(layer, particlesRef.current, mapW, mapH);
    }

    const particles = particlesRef.current;
    return () => {
      particles.forEach((p) => p.graphics.destroy());
      particles.length = 0;
    };
  }, [loading, particleLayerRef, mapPixelRef]);

  function spawnDust(layer: Container, particles: ActiveParticle[], mapW: number, mapH: number) {
    if (particles.length >= MAX_PARTICLES) return;
    const g = new Graphics();
    const size = 1 + Math.random();
    g.circle(0, 0, size).fill({ color: 0xffffff, alpha: 0.05 + Math.random() * 0.1 });
    const x = Math.random() * mapW;
    const y = Math.random() * mapH;
    g.x = x;
    g.y = y;
    layer.addChild(g);
    particles.push({
      graphics: g,
      x,
      y,
      vx: (Math.random() - 0.5) * 0.05,
      vy: -0.02 - Math.random() * 0.03,
      life: 0,
      maxLife: 8000 + Math.random() * 12000,
      type: "dust",
    });
  }

  function spawnSteam(layer: Container, particles: ActiveParticle[], sx: number, sy: number) {
    if (particles.length >= MAX_PARTICLES) return;
    const g = new Graphics();
    g.circle(0, 0, 1 + Math.random()).fill({ color: 0xffffff, alpha: 0.2 });
    g.x = sx + (Math.random() - 0.5) * 4;
    g.y = sy;
    layer.addChild(g);
    particles.push({
      graphics: g,
      x: g.x,
      y: g.y,
      vx: (Math.random() - 0.5) * 0.08,
      vy: -0.1 - Math.random() * 0.05,
      life: 0,
      maxLife: 2000 + Math.random() * 1500,
      type: "steam",
    });
  }

  function spawnSpark(layer: Container, particles: ActiveParticle[], sx: number, sy: number) {
    if (particles.length >= MAX_PARTICLES) return;
    const count = 1 + Math.floor(Math.random() * 3);
    for (let i = 0; i < count; i++) {
      const g = new Graphics();
      g.circle(0, 0, 1).fill({ color: 0x4ade80, alpha: 0.6 + Math.random() * 0.4 });
      g.x = sx + (Math.random() - 0.5) * 8;
      g.y = sy;
      layer.addChild(g);
      particles.push({
        graphics: g,
        x: g.x,
        y: g.y,
        vx: (Math.random() - 0.5) * 0.3,
        vy: -0.2 - Math.random() * 0.15,
        life: 0,
        maxLife: 400 + Math.random() * 300,
        type: "spark",
      });
    }
  }

  function updateParticles(dtMs: number) {
    const layer = particleLayerRef.current;
    if (!layer) return;

    const particles = particlesRef.current;
    const { w: mapW, h: mapH } = mapPixelRef.current;

    // Update existing particles
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life += dtMs;
      if (p.life >= p.maxLife) {
        p.graphics.destroy();
        particles.splice(i, 1);
        continue;
      }

      // Move
      const t = dtMs / 16.67; // normalize to ~60fps
      p.x += p.vx * t;
      p.y += p.vy * t;

      // Dust: horizontal sine wave
      if (p.type === "dust") {
        p.x += Math.sin(Date.now() * 0.001 + p.y * 0.1) * 0.02;
      }

      p.graphics.x = p.x;
      p.graphics.y = p.y;

      // Fade in/out
      const lifeRatio = p.life / p.maxLife;
      if (lifeRatio < 0.1) {
        p.graphics.alpha = lifeRatio / 0.1;
      } else if (lifeRatio > 0.8) {
        p.graphics.alpha = (1 - lifeRatio) / 0.2;
      }
    }

    // Respawn dust to maintain count
    const dustCount = particles.filter((p) => p.type === "dust").length;
    if (dustCount < DUST_COUNT) {
      spawnDust(layer, particles, mapW, mapH);
    }

    // Spawn steam near break agents
    agentSpritesRef.current.forEach((sprite, id) => {
      const agent = agentsRef.current.find((a) => a.id === id);
      if (!agent || agent.status !== "break") return;
      const anim = agentAnimRef.current.get(id);
      // Only when stationary (not walking)
      if (anim && anim.path.length > 0 && anim.pathIdx < anim.path.length - 1) return;
      // Spawn occasionally
      if (Math.random() < 0.003) {
        spawnSteam(layer, particles, sprite.x, sprite.y - 20);
      }
    });

    // Spawn keyboard sparks for working seated agents
    agentSpritesRef.current.forEach((sprite, id) => {
      const agent = agentsRef.current.find((a) => a.id === id);
      if (!agent || agent.status !== "working") return;
      const anim = agentAnimRef.current.get(id);
      if (!anim?.seatDirection) return; // only when seated

      let timer = sparkTimersRef.current.get(id) ?? 0;
      timer -= dtMs;
      if (timer <= 0) {
        spawnSpark(layer, particles, sprite.x, sprite.y - 15);
        timer = SPARK_INTERVAL_MIN + Math.random() * (SPARK_INTERVAL_MAX - SPARK_INTERVAL_MIN);
      }
      sparkTimersRef.current.set(id, timer);
    });

    // Clean up spark timers for departed agents
    const currentAgentIds = new Set(agentsRef.current.map((a) => a.id));
    for (const id of sparkTimersRef.current.keys()) {
      if (!currentAgentIds.has(id)) {
        sparkTimersRef.current.delete(id);
      }
    }
  }

  return { updateParticles };
}
