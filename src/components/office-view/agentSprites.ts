import { Assets, Rectangle, Texture } from "pixi.js";
import { stableAgentHash } from "../AgentAvatar";

/**
 * 2D Pixel Art Characters sprite sheets are ~60×128 with a 3×4 grid (20×32 per frame).
 * Row 0 = walk-down, Row 1 = walk-left, Row 2 = walk-right, Row 3 = walk-up.
 */
const CHAR_FRAME_W = 20;
const CHAR_FRAME_H = 32;
const CHAR_COLS = 3;

/** Walk animation speed: ms between frame changes */
export const WALK_FRAME_MS = 150;
/** Agent movement speed in pixels per frame (at 60fps) */
export const AGENT_SPEED = 0.9;
/** Tile size for pathfinding coordinate conversion */
export const TILE_W = 32;
export const TILE_H = 32;

/** Team area names in the map's object layer */
export const TEAM_AREA_NAMES = ["team1", "team2", "team3", "team4", "team5", "team6", "team7"];

export type WalkDir = "down" | "left" | "right" | "up";

export interface WalkFrames {
  down: Texture[];
  left: Texture[];
  right: Texture[];
  up: Texture[];
}

export interface AgentAnimState {
  frames: WalkFrames;
  path: import("./pathfinding").PathPoint[]; // pixel-coordinate waypoints
  pathIdx: number;
  targetX: number;
  targetY: number;
  walkFrame: number; // 0-2
  walkTime: number; // accumulator (ms)
  direction: WalkDir;
  /** Pixel-coordinate wander destination for idle/break agents. null = not yet assigned. */
  wanderTarget: { x: number; y: number } | null;
  /** Countdown in ms until next wander target is picked. */
  wanderTimer: number;
  /** Direction the agent should face when seated. null = not at a seat. */
  seatDirection: WalkDir | null;
}

/** Pick an item from an array using a stable hash */
export function pickByHash<T>(arr: T[], key: string): T | undefined {
  if (arr.length === 0) return undefined;
  return arr[stableAgentHash(key) % arr.length];
}

/** Module-level cache: avoids recreating 12 Texture objects per character on every call */
const walkFramesCache = new Map<number, WalkFrames>();

/** Load the full character sprite sheet and extract directional walk frames */
export async function loadCharWalkFrames(charIndex: number): Promise<WalkFrames> {
  const cached = walkFramesCache.get(charIndex);
  if (cached) return cached;

  const padded = String(charIndex).padStart(3, "0");
  const sheetPath = `/assets/2D Top Down Pixel Art Characters/${padded}.png`;
  const sheet = await Assets.load(sheetPath);
  const frames: WalkFrames = { down: [], left: [], right: [], up: [] };
  const dirs: WalkDir[] = ["down", "left", "right", "up"];
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < CHAR_COLS; col++) {
      const tex = new Texture({
        source: sheet.source,
        frame: new Rectangle(col * CHAR_FRAME_W, row * CHAR_FRAME_H, CHAR_FRAME_W, CHAR_FRAME_H),
      });
      frames[dirs[row]].push(tex);
    }
  }
  walkFramesCache.set(charIndex, frames);
  return frames;
}
