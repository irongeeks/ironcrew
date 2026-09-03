import { useEffect, useRef, type MutableRefObject, type Dispatch, type SetStateAction } from "react";
import { Application, Container, Graphics, Rectangle, Text, TextureStyle } from "pixi.js";
import { loadTiledMap, type TiledObject } from "./TiledRenderer";
import { buildCollisionGrid, findPath, simplifyPath, pixelToTile, tileToCenterPixel } from "./pathfinding";
import { stableAgentHash } from "../AgentAvatar";
import { AGENT_SPEED, TILE_W, TILE_H, WALK_FRAME_MS, type AgentAnimState } from "./agentSprites";
import { tickerStepEnabled, particleOpacityFor } from "./animation-policy";
import { usePrefersReducedMotion } from "../../hooks/usePrefersReducedMotion";
import type { Agent, Department, ServerAllocation, ServerNode } from "../../types";

/** Map tileset source names from office_map.json to actual image URLs */
const TILESET_IMAGES: Record<string, string> = {
  "MainTileMap.tsx": "/assets/MainTileMap.png",
  "Room_Builder_Office_32x32.tsx": "/assets/Room_Builder_Office_32x32.png",
  "Modern_Office_Shadowless_32x32.tsx": "/assets/Modern_Office_Shadowless_32x32.png",
  "Interiors_free_32x32.tsx": "/assets/Interiors_free_32x32.png",
  "Room_Builder_free_32x32.tsx": "/assets/Room_Builder_free_32x32.png",
};

const MOBILE_BREAKPOINT = 768;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2.0;

export function usePixiApp(
  containerRef: MutableRefObject<HTMLDivElement | null>,
  appRef: MutableRefObject<Application | null>,
  worldRef: MutableRefObject<Container | null>,
  agentLayerRef: MutableRefObject<Container | null>,
  agentSpritesRef: MutableRefObject<Map<string, Container>>,
  agentAnimRef: MutableRefObject<Map<string, AgentAnimState>>,
  collisionGridRef: MutableRefObject<Uint8Array | null>,
  mapDimsRef: MutableRefObject<{ w: number; h: number }>,
  mapPixelRef: MutableRefObject<{ w: number; h: number }>,
  serverSpritesRef: MutableRefObject<Map<string, Container>>,
  serverSlotsRef: MutableRefObject<Array<{ x: number; y: number; name: string }>>,
  objectsRef: MutableRefObject<TiledObject[]>,
  zoomRef: MutableRefObject<number>,
  setZoom: Dispatch<SetStateAction<number>>,
  setLoading: Dispatch<SetStateAction<boolean>>,
  agentsRef: MutableRefObject<Agent[]>,
  departmentsRef: MutableRefObject<Department[]>,
  serversRef: MutableRefObject<ServerNode[]>,
  serverAllocationsRef: MutableRefObject<ServerAllocation[]>,
  _onSelectAgentRef: MutableRefObject<(agent: Agent) => void>,
  onSelectServerRef: MutableRefObject<(server: ServerNode | null) => void>,
  onSelectDepartmentRef: MutableRefObject<(dept: Department) => void>,
  getAgentTarget: (agent: Agent) => { x: number; y: number; seatDirection: import("./agentSprites").WalkDir | null },
  shadowLayerRef: MutableRefObject<Container | null>,
  updateShadowsRef: MutableRefObject<() => void>,
  particleLayerRef: MutableRefObject<Container | null>,
  updateParticlesRef: MutableRefObject<(dtMs: number) => void>,
) {
  // ── ACCESSIBILITY: prefers-reduced-motion ──
  const reducedMotion = usePrefersReducedMotion();
  const reducedMotionRef = useRef(reducedMotion);
  reducedMotionRef.current = reducedMotion;

  useEffect(() => {
    if (typeof document === "undefined") return;
    const cls = "reduced-motion";
    if (reducedMotion) {
      document.body.classList.add(cls);
    } else {
      document.body.classList.remove(cls);
    }
    return () => {
      document.body.classList.remove(cls);
    };
  }, [reducedMotion]);

  // Keep particle layer in sync with the preference (idle keyframes already
  // collapse via animation-policy, but the layer-level alpha is a cheap kill
  // switch for any in-flight Graphics objects).
  useEffect(() => {
    const layer = particleLayerRef.current;
    if (!layer) return;
    layer.alpha = particleOpacityFor(reducedMotion, 1);
  }, [reducedMotion, particleLayerRef]);

  // ── PIXI INIT ──
  useEffect(() => {
    let destroyed = false;

    const initPixi = async () => {
      const el = containerRef.current;
      if (!el) return;

      TextureStyle.defaultOptions.scaleMode = "nearest";

      const app = new Application();
      await app.init({
        width: 800,
        height: 480,
        backgroundColor: 0x1e1e1e,
        antialias: false,
        resolution: Math.min(window.devicePixelRatio || 1, 2),
        autoDensity: true,
      });

      if (destroyed) {
        app.destroy(true);
        return;
      }

      el.appendChild(app.canvas);
      appRef.current = app;

      const canvas = app.canvas as HTMLCanvasElement;
      canvas.style.width = "auto";
      canvas.style.maxWidth = "100%";
      canvas.style.maxHeight = "100%";
      canvas.style.height = "auto";
      canvas.style.display = "block";
      canvas.style.margin = "auto";
      // imageRendering not forced — TextureStyle.defaultOptions.scaleMode = "nearest" keeps sprites crisp

      // Load tiled map
      const { container, layersContainer, objectGroups, mapData, mapWidth, mapHeight } = await loadTiledMap(
        "/office_map.json",
        TILESET_IMAGES,
      );

      if (destroyed) return;

      // Build collision grid for pathfinding
      collisionGridRef.current = buildCollisionGrid(mapData);
      mapDimsRef.current = { w: mapData.width, h: mapData.height };
      mapPixelRef.current = { w: mapWidth, h: mapHeight };

      // Auto-fit zoom: scale map to fill the full container
      const isMobileInit = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`).matches;
      if (!isMobileInit) {
        const parentEl = containerRef.current?.parentElement;
        const availH = parentEl?.clientHeight ?? window.innerHeight;
        const availW = parentEl?.clientWidth ?? window.innerWidth;
        const autoZoomH = availH / mapHeight;
        const autoZoomW = availW / mapWidth;
        const autoZoom = Math.min(autoZoomH, autoZoomW); // contain — full office visible
        const clampedZoom = Math.min(MAX_ZOOM, Math.round(autoZoom * 10) / 10);
        zoomRef.current = clampedZoom;
        setZoom(clampedZoom);
      }

      const world = new Container();
      worldRef.current = world;
      app.stage.addChild(world);
      world.addChild(container);
      const allObjects = objectGroups["Objektebene 1"] || [];
      objectsRef.current = allObjects;

      // Cache static map tiles as a single texture
      layersContainer.cacheAsTexture({
        resolution: 1,
        antialias: false, // preserve pixel-art crispness
      });

      // Disable hit testing on cached map tiles
      layersContainer.interactiveChildren = false;

      // Dynamic layers are direct children of world (outside cached layersContainer)
      const shadowLayer = new Container();
      shadowLayer.label = "shadows";
      world.addChild(shadowLayer);
      shadowLayerRef.current = shadowLayer;

      const agentLayer = new Container();
      agentLayer.label = "agents";
      agentLayer.isRenderGroup = true; // GPU-offloaded transforms for moving agents
      world.addChild(agentLayer);
      agentLayerRef.current = agentLayer;

      const particleLayer = new Container();
      particleLayer.label = "particles";
      world.addChild(particleLayer);
      particleLayerRef.current = particleLayer;

      const applyViewportLayout = () => {
        if (!worldRef.current) return;
        const isMobile = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`).matches;
        if (isMobile) {
          worldRef.current.rotation = 0;
          const containerWidth = containerRef.current?.clientWidth ?? window.innerWidth;
          const scale = containerWidth / mapWidth;
          worldRef.current.scale.set(scale);
          worldRef.current.position.set(0, 0);
          app.renderer.resize(Math.round(mapWidth * scale), Math.round(mapHeight * scale));
          canvas.style.width = "100%";
          canvas.style.height = "auto";
          canvas.style.maxWidth = "100%";
          canvas.style.maxHeight = "100%";
          canvas.style.margin = "0 auto";
        } else {
          worldRef.current.rotation = 0;
          worldRef.current.scale.set(zoomRef.current);
          worldRef.current.position.set(0, 0);
          app.renderer.resize(
            Math.round(mapPixelRef.current.w * zoomRef.current),
            Math.round(mapPixelRef.current.h * zoomRef.current),
          );
          // Contain — show at rendered size, centered in container
          canvas.style.width = "auto";
          canvas.style.height = "auto";
          canvas.style.maxWidth = "100%";
          canvas.style.maxHeight = "100%";
          canvas.style.margin = "auto";
          canvas.style.display = "block";
          canvas.style.objectFit = "contain";
        }
      };

      applyViewportLayout();
      const handleResize = () => applyViewportLayout();
      window.addEventListener("resize", handleResize);

      // ── PINCH-TO-ZOOM ──
      let pointerCache: PointerEvent[] = [];
      let prevPinchDist = -1;

      const onPointerDown = (e: PointerEvent) => {
        pointerCache.push(e);
      };
      const onPointerUp = (e: PointerEvent) => {
        pointerCache = pointerCache.filter((p) => p.pointerId !== e.pointerId);
        if (pointerCache.length < 2) prevPinchDist = -1;
      };
      const onPointerMove = (e: PointerEvent) => {
        const idx = pointerCache.findIndex((p) => p.pointerId === e.pointerId);
        if (idx >= 0) pointerCache[idx] = e;

        if (pointerCache.length === 2) {
          const dx = pointerCache[0].clientX - pointerCache[1].clientX;
          const dy = pointerCache[0].clientY - pointerCache[1].clientY;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (prevPinchDist > 0) {
            const delta = dist / prevPinchDist;
            const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoomRef.current * delta));
            zoomRef.current = newZoom;
            setZoom(newZoom);
            const isMobile = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`).matches;
            if (!isMobile && worldRef.current && app.renderer) {
              worldRef.current.scale.set(newZoom);
              worldRef.current.position.set(0, 0);
              app.renderer.resize(
                Math.round(mapPixelRef.current.w * newZoom),
                Math.round(mapPixelRef.current.h * newZoom),
              );
            }
          }
          prevPinchDist = dist;
        }
      };

      canvas.addEventListener("pointerdown", onPointerDown);
      canvas.addEventListener("pointerup", onPointerUp);
      canvas.addEventListener("pointercancel", onPointerUp);
      canvas.addEventListener("pointermove", onPointerMove);
      // Prevent default touch scrolling on canvas to avoid interference with pinch
      const preventTouchDefault = (e: TouchEvent) => {
        if (e.touches.length >= 2) e.preventDefault();
      };
      canvas.addEventListener("touchmove", preventTouchDefault, { passive: false });

      // ── CLICKABLE TEAM AREAS ──
      const teamAreas = allObjects
        .filter((o) => o.width > 0 && o.height > 0 && /^(team\d|office_\d+)$/i.test(o.name))
        .sort((a, b) => a.x - b.x || a.y - b.y);
      for (const area of teamAreas) {
        const zone = new Graphics();
        zone.rect(area.x, area.y, area.width, area.height).fill({ color: 0x4ade80, alpha: 0.08 });
        zone.rect(area.x, area.y, area.width, area.height).stroke({ color: 0x4ade80, alpha: 0.3, width: 1 });
        zone.alpha = 0; // hidden by default, shown on hover
        zone.eventMode = "static";
        zone.hitArea = new Rectangle(area.x, area.y, area.width, area.height);
        zone.cursor = "pointer";
        zone.on("pointerover", () => {
          zone.alpha = 1;
        });
        zone.on("pointerout", () => {
          zone.alpha = 0;
        });
        zone.on("pointerdown", () => {
          const num = parseInt(area.name.replace(/\D/g, ""), 10) - 1;
          const dept = departmentsRef.current[num % departmentsRef.current.length];
          if (dept) onSelectDepartmentRef.current(dept);
        });
        world.addChild(zone);

        // Department label
        const deptIdx = parseInt(area.name.replace(/\D/g, ""), 10) - 1;
        const dept = departmentsRef.current[deptIdx % departmentsRef.current.length];
        if (dept) {
          const label = new Text({
            text: `${dept.icon} ${dept.name}`.toUpperCase(),
            style: {
              fontFamily: '"Upheaval TT BRK", "Press Start 2P", monospace',
              fontSize: 14,
              fill: 0xffffff,
              stroke: { color: 0x000000, width: 3 },
            },
          });
          label.resolution = 2;
          label.x = area.x + 6;
          label.y = area.y + 4;

          const bg = new Graphics();
          bg.rect(label.x - 3, label.y - 2, label.width + 6, label.height + 4).fill({ color: 0x000000, alpha: 0.7 });
          world.addChild(bg);
          world.addChild(label);
        }
      }

      // ── ROOM LABELS ──
      const addRoomLabel = (text: string, x: number, y: number, color: number = 0xfacc15, anchorX: number = 0) => {
        const label = new Text({
          text,
          style: {
            fontFamily: '"Upheaval TT BRK", "Press Start 2P", monospace',
            fontSize: 16,
            fill: color,
            stroke: { color: 0x000000, width: 3 },
          },
        });
        label.resolution = 2;
        label.anchor.set(anchorX, 0);
        label.x = x;
        label.y = y;

        const bg = new Graphics();
        const bgX = x - label.width * anchorX - 3;
        bg.rect(bgX, y - 2, label.width + 6, label.height + 4).fill({ color: 0x000000, alpha: 0.7 });
        world.addChild(bg);
        world.addChild(label);
      };

      const meetingObjs = allObjects.filter((o) => /^meeting.?room$/i.test(o.name) || o.name === "Conference_room");
      if (meetingObjs.length > 0) {
        const mr = meetingObjs[0];
        addRoomLabel("MEETING ROOM", mr.x + 6, mr.y + 6);
      } else {
        addRoomLabel("MEETING ROOM", 50, 50);
      }

      const balkonyObjs = allObjects.filter((o) => /balkony|balcony|balkon/i.test(o.name) && o.width > 0);
      if (balkonyObjs.length > 0) {
        const balk = balkonyObjs[0];
        addRoomLabel("BALKONY", balk.x + 6, balk.y + 6, 0x38bdf8);
      }

      const ceoObjs = allObjects.filter((o) => /^(office_ceo|ceo_office)$/i.test(o.name));
      if (ceoObjs.length > 0) {
        const ceo = ceoObjs[0];
        addRoomLabel("CEO", ceo.x + ceo.width / 2, ceo.y + 6, 0xfacc15, 0.5);
      }

      const serverObjs = allObjects.filter((o) => o.name.toLowerCase().startsWith("server"));
      if (serverObjs.length > 0) {
        addRoomLabel("SERVER ROOM", serverObjs[0].x + 6, serverObjs[0].y + 6, 0x3b82f6);
        serverSlotsRef.current = serverObjs
          .sort((a, b) => a.x - b.x || a.y - b.y)
          .map((obj) => ({
            x: obj.x + obj.width / 2,
            y: obj.y + obj.height - 2,
            name: obj.name,
          }));
      }

      const serverRoomObj = allObjects.find((o) => o.name === "Server-Room");
      if (serverRoomObj) {
        const serverZone = new Graphics();
        serverZone
          .rect(serverRoomObj.x, serverRoomObj.y, serverRoomObj.width, serverRoomObj.height)
          .fill({ color: 0x3b82f6, alpha: 0.08 });
        serverZone
          .rect(serverRoomObj.x, serverRoomObj.y, serverRoomObj.width, serverRoomObj.height)
          .stroke({ color: 0x3b82f6, alpha: 0.3, width: 1 });
        serverZone.alpha = 0;
        serverZone.eventMode = "static";
        serverZone.hitArea = new Rectangle(serverRoomObj.x, serverRoomObj.y, serverRoomObj.width, serverRoomObj.height);
        serverZone.cursor = "pointer";
        serverZone.on("pointerover", () => {
          serverZone.alpha = 1;
        });
        serverZone.on("pointerout", () => {
          serverZone.alpha = 0;
        });
        serverZone.on("pointerdown", () => {
          onSelectServerRef.current(null);
        });
        world.addChild(serverZone);
      }

      setLoading(false);

      // ── ANIMATION LOOP ──
      app.ticker.add((ticker) => {
        const grid = collisionGridRef.current;
        const { w: gw, h: gh } = mapDimsRef.current;
        const dtMs = ticker.deltaMS;
        const policy = tickerStepEnabled(reducedMotionRef.current);

        agentSpritesRef.current.forEach((sprite, id) => {
          const agent = agentsRef.current.find((a) => a.id === id);
          if (!agent) return;
          const anim = agentAnimRef.current.get(id);
          if (!anim) return;

          // ── Wander timer (break agents only — idle agents stay at their desk) ──
          if (policy.wander && (agent.status === "break" || (agent.status === "idle" && !agent.department_id))) {
            anim.wanderTimer -= dtMs;
            if (anim.wanderTimer <= 0 || anim.wanderTarget === null) {
              if (grid) {
                // Collect all walkable tile indices
                const walkable: number[] = [];
                for (let i = 0; i < grid.length; i++) {
                  if (grid[i] === 1) walkable.push(i);
                }
                if (walkable.length > 0) {
                  const startTile = pixelToTile(sprite.x, sprite.y, TILE_W, TILE_H);
                  // Try up to 8 random tiles, pick first one A* can actually reach
                  let picked = false;
                  for (let attempt = 0; attempt < 8; attempt++) {
                    const tileIdx = walkable[Math.floor(Math.random() * walkable.length)];
                    const tx = tileIdx % gw;
                    const ty = Math.floor(tileIdx / gw);
                    if (findPath(grid, gw, gh, startTile, { x: tx, y: ty }).length > 0) {
                      anim.wanderTarget = tileToCenterPixel(tx, ty, TILE_W, TILE_H);
                      picked = true;
                      break;
                    }
                  }
                  if (!picked) anim.wanderTarget = null; // stay put this cycle
                }
              }
              // Next wander in 20–40 seconds
              anim.wanderTimer = 20000 + Math.random() * 20000;
            }
          } else {
            // Reset wander state when agent becomes active again
            anim.wanderTarget = null;
            anim.wanderTimer = 0;
          }

          const target = getAgentTarget(agent);

          // Store seat direction in anim state
          anim.seatDirection = target.seatDirection;

          // Recompute path when target changes
          if (Math.abs(target.x - anim.targetX) > 2 || Math.abs(target.y - anim.targetY) > 2) {
            anim.targetX = target.x;
            anim.targetY = target.y;
            if (grid) {
              const startTile = pixelToTile(sprite.x, sprite.y, TILE_W, TILE_H);
              const endTile = pixelToTile(target.x, target.y, TILE_W, TILE_H);
              const tilePath = findPath(grid, gw, gh, startTile, endTile);
              const simplified = simplifyPath(tilePath);
              // Convert tile path to pixel waypoints (tile centers), keep exact target as last point
              anim.path = simplified.map((t) => tileToCenterPixel(t.x, t.y, TILE_W, TILE_H));
              if (anim.path.length > 0) {
                anim.path[anim.path.length - 1] = { x: target.x, y: target.y };
              }
            } else {
              anim.path = [{ x: target.x, y: target.y }];
            }
            anim.pathIdx = 0;
          }

          // Follow waypoints — gated by `policy.move` so sprites freeze at
          // their current position under prefers-reduced-motion (no per-tick
          // canvas movement, no path advancement). When motion resumes, the
          // existing path/pathIdx state is preserved so the agent continues
          // from where it left off.
          const waypoint = anim.path[anim.pathIdx];
          let moving = false;
          if (policy.move && waypoint) {
            const dx = waypoint.x - sprite.x;
            const dy = waypoint.y - sprite.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist > 1.5) {
              moving = true;
              const step = AGENT_SPEED * ticker.deltaTime;
              if (step >= dist) {
                sprite.x = waypoint.x;
                sprite.y = waypoint.y;
              } else {
                sprite.x += (dx / dist) * step;
                sprite.y += (dy / dist) * step;
              }
              // Determine walk direction from dominant axis
              if (Math.abs(dx) > Math.abs(dy)) {
                anim.direction = dx > 0 ? "right" : "left";
              } else {
                anim.direction = dy > 0 ? "down" : "up";
              }
            } else {
              sprite.x = waypoint.x;
              sprite.y = waypoint.y;
              // Advance to next waypoint
              if (anim.pathIdx < anim.path.length - 1) {
                anim.pathIdx++;
                moving = true;
              }
            }
          }

          const baseSprite = sprite.getChildByLabel("body") as import("pixi.js").Sprite | null;
          if (baseSprite) {
            if (moving) {
              // Walk animation: cycle frames 0→1→2→1→0 (ping-pong) — disabled
              // under prefers-reduced-motion so the sprite freezes on its idle frame.
              if (policy.walkCycle) {
                anim.walkTime += dtMs;
                if (anim.walkTime >= WALK_FRAME_MS) {
                  anim.walkTime -= WALK_FRAME_MS;
                  anim.walkFrame = (anim.walkFrame + 1) % 4; // 0,1,2,3 → maps to 0,1,2,1
                }
                const frameIdx = anim.walkFrame >= 3 ? 1 : anim.walkFrame; // ping-pong: 0,1,2,1
                const dirFrames = anim.frames[anim.direction];
                if (dirFrames[frameIdx]) {
                  baseSprite.texture = dirFrames[frameIdx];
                }
              } else {
                const idleFrames = anim.frames[anim.direction];
                const idleFrame = idleFrames[1] ?? idleFrames[0];
                if (idleFrame) baseSprite.texture = idleFrame;
                anim.walkFrame = 0;
                anim.walkTime = 0;
              }
              baseSprite.y = 0;
            } else {
              // Idle: face seat direction if seated, otherwise last walk direction
              if (anim.seatDirection) {
                anim.direction = anim.seatDirection;
              }
              const idleFrames = anim.frames[anim.direction];
              const idleFrame = idleFrames[1] ?? idleFrames[0];
              if (idleFrame) baseSprite.texture = idleFrame;
              anim.walkFrame = 0;
              anim.walkTime = 0;

              // Seated agents: Y-offset to align torso with chair + reduced bobbing
              const isSeated = anim.seatDirection !== null;
              const seatOffset = isSeated ? -8 : 0;
              const bobAmplitude = isSeated ? 0.15 : agent.status === "working" ? 0.3 : 0.6;
              // Typing animation: irregular head-bob when working at desk
              let typingBob = 0;
              if (policy.typingJitter && isSeated && agent.status === "working") {
                typingBob = Math.sin(Date.now() * 0.018 + stableAgentHash(id) * 7) > 0.3 ? -1 : 0;
              }
              const headBobOffset = policy.headBob
                ? Math.sin(Date.now() * 0.002 + stableAgentHash(id)) * bobAmplitude
                : 0;
              baseSprite.y = seatOffset + typingBob + headBobOffset;
            }
          }

          // Status indicator color
          const indicator = sprite.getChildByLabel("indicator") as Graphics | null;
          if (indicator) {
            const color = agent.status === "working" ? 0x4ade80 : agent.status === "break" ? 0xfacc15 : 0x94a3b8;
            indicator.clear().circle(0, 0, 2.5).fill(color);
            indicator.visible = true;
          }
        });

        // Update shadow layer
        updateShadowsRef.current();
        // Skip ambient particle updates entirely when reduced motion is on
        // (layer alpha is also 0 — see effect above).
        if (!reducedMotionRef.current) {
          updateParticlesRef.current(dtMs);
        }

        const statusColor = (status: ServerNode["status"]) => {
          if (status === "online") return 0x4ade80;
          if (status === "busy") return 0xf59e0b;
          if (status === "idle") return 0x22d3ee;
          return 0x64748b;
        };
        const activeByServer = new Map<string, ServerAllocation>();
        for (const allocation of serverAllocationsRef.current) {
          if (allocation.status !== "active" || !allocation.server_id) continue;
          if (!activeByServer.has(allocation.server_id)) activeByServer.set(allocation.server_id, allocation);
        }
        serverSpritesRef.current.forEach((sprite, id) => {
          const server = serversRef.current.find((entry) => entry.id === id);
          if (!server) return;
          const indicator = sprite.getChildByLabel("indicator") as Graphics | null;
          if (indicator) {
            indicator.clear().circle(0, 0, 2.5).fill(statusColor(server.status));
          }
          const bindText = sprite.getChildByLabel("bind") as Text | null;
          if (bindText) {
            const active = activeByServer.get(server.id);
            bindText.text = active?.agent_name ? active.agent_name.toUpperCase().slice(0, 10) : "IDLE";
          }
        });
      });
      return () => {
        window.removeEventListener("resize", handleResize);
        canvas.removeEventListener("pointerdown", onPointerDown);
        canvas.removeEventListener("pointerup", onPointerUp);
        canvas.removeEventListener("pointercancel", onPointerUp);
        canvas.removeEventListener("pointermove", onPointerMove);
        canvas.removeEventListener("touchmove", preventTouchDefault);
      };
    };

    let disposeLayout: (() => void) | undefined;
    initPixi().then((dispose) => {
      disposeLayout = dispose;
    });

    return () => {
      destroyed = true;
      disposeLayout?.();
      if (appRef.current) {
        appRef.current.destroy(true, { children: true, texture: true });
        appRef.current = null;
      }
      worldRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
