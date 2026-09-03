import { useCallback, type MutableRefObject } from "react";
import type { TiledObject } from "./TiledRenderer";
import { tileToCenterPixel } from "./pathfinding";
import { stableAgentHash } from "../AgentAvatar";
import { pickByHash, TEAM_AREA_NAMES, TILE_W, TILE_H, type AgentAnimState, type WalkDir } from "./agentSprites";
import type { Agent, Department } from "../../types";

/** Extract direction custom property from a seat object */
export function getSeatDirection(seat: TiledObject): WalkDir | null {
  const prop = seat.properties?.find((p) => p.name === "direction");
  if (prop && typeof prop.value === "string") {
    const val = prop.value as string;
    if (val === "up" || val === "down" || val === "left" || val === "right") return val;
  }
  return null;
}

export function useAgentPositions(
  objectsRef: MutableRefObject<TiledObject[]>,
  departmentsRef: MutableRefObject<Department[]>,
  agentAnimRef: MutableRefObject<Map<string, AgentAnimState>>,
  collisionGridRef: MutableRefObject<Uint8Array | null>,
  mapDimsRef: MutableRefObject<{ w: number; h: number }>,
) {
  /** Build a map: departmentId -> team index (0-based) */
  const getDeptTeamIndex = useCallback(
    (deptId: string): number => {
      const idx = departmentsRef.current.findIndex((d) => d.id === deptId);
      return idx >= 0 ? idx % TEAM_AREA_NAMES.length : 0;
    },
    [departmentsRef],
  );

  /** Get all objects whose name matches a pattern, sorted for stability */
  const getObjects = useCallback(
    (pattern: string): TiledObject[] =>
      objectsRef.current
        .filter((o) => o.name.toLowerCase().includes(pattern.toLowerCase()))
        .sort((a, b) => a.x - b.x || a.y - b.y),
    [objectsRef],
  );

  /** Determine where an agent should be positioned */
  const getAgentTarget = useCallback(
    (agent: Agent): { x: number; y: number; seatDirection: WalkDir | null } => {
      const id = agent.id;

      // CEO agent always sits at CEO_seat regardless of status
      const ceoSeats = getObjects("ceo_seat");
      if (ceoSeats.length > 0) {
        const dept = departmentsRef.current.find((d) => d.id === agent.department_id);
        if (dept && /ceo|chief|executive/i.test(dept.name)) {
          return { x: ceoSeats[0].x, y: ceoSeats[0].y, seatDirection: getSeatDirection(ceoSeats[0]) };
        }
      }

      // Working and idle agents → sit at their department desk
      if ((agent.status === "working" || agent.status === "idle") && agent.department_id) {
        const teamIdx = getDeptTeamIndex(agent.department_id);
        const teamNum = teamIdx + 1;
        const seats = getObjects(`office${teamNum}_seat`);
        if (seats.length > 0) {
          const seat = pickByHash(seats, id)!;
          return { x: seat.x, y: seat.y, seatDirection: getSeatDirection(seat) };
        }
        const genericSeats = getObjects("_seat").filter((s) => s.name !== "CEO_seat");
        if (genericSeats.length > 0) {
          const seat = pickByHash(genericSeats, id)!;
          return { x: seat.x, y: seat.y, seatDirection: getSeatDirection(seat) };
        }
      }

      // Break agents (or agents without a department) → wander occasionally
      const anim = agentAnimRef.current.get(id);
      if (anim?.wanderTarget) return { ...anim.wanderTarget, seatDirection: null };

      // Fallback before first wander target is assigned — pick a walkable tile
      const grid = collisionGridRef.current;
      const { w: gw } = mapDimsRef.current;
      if (grid) {
        const walkable: number[] = [];
        for (let i = 0; i < grid.length; i++) {
          if (grid[i] === 1) walkable.push(i);
        }
        if (walkable.length > 0) {
          const tileIdx = walkable[stableAgentHash(id) % walkable.length];
          return { ...tileToCenterPixel(tileIdx % gw, Math.floor(tileIdx / gw), TILE_W, TILE_H), seatDirection: null };
        }
      }
      return { x: 100 + (stableAgentHash(id) % 300), y: 200 + (stableAgentHash(id) % 150), seatDirection: null };
    },
    [getDeptTeamIndex, getObjects, departmentsRef, agentAnimRef, collisionGridRef, mapDimsRef],
  );

  return { getDeptTeamIndex, getObjects, getAgentTarget };
}
