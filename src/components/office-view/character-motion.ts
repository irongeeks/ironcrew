/**
 * How the figures move, beyond swapping walk frames.
 *
 * The office already ping-pongs three walk frames per direction. That reads as
 * "the sprite is animating"; it does not read as "someone is walking over
 * there". The difference is the secondary motion an animator adds around the
 * frames: weight on the footfall, a lean into the direction of travel, breath
 * while standing still, a blink.
 *
 * All of it is arithmetic applied to sprite transforms that already exist —
 * scale, rotation, a few pixels of offset. It adds **no draw calls, no
 * textures and no fill rate**, which is why it stays switched on even at the
 * lowest quality tier (see `render-quality.ts`): it is the part of "looks
 * alive" that a weak GPU does not pay for.
 *
 * Everything here is a pure function of (phase, state) so the motion can be
 * tested as numbers rather than eyeballed as pixels.
 */

import type { AgentStatus } from "./motion-status.ts";

/** One full walk cycle, in milliseconds. Two footfalls. */
export const WALK_CYCLE_MS = 600;
/** One breath, in milliseconds. Deliberately slower than a walk cycle. */
export const BREATH_CYCLE_MS = 3600;
/** How often a figure blinks, on average. */
export const BLINK_INTERVAL_MS = 4200;
/** How long a blink lasts. Short enough to be felt rather than seen. */
export const BLINK_DURATION_MS = 110;

/** What to apply to a sprite this frame. */
export interface MotionTransform {
  /** Vertical offset in pixels. Negative is up. */
  offsetY: number;
  /** Horizontal offset in pixels. */
  offsetX: number;
  /** Horizontal scale multiplier — the "stretch" half of squash-and-stretch. */
  scaleX: number;
  /** Vertical scale multiplier — the "squash" half. */
  scaleY: number;
  /** Rotation in radians. Small: a lean, never a tumble. */
  rotation: number;
}

export const NEUTRAL: MotionTransform = { offsetY: 0, offsetX: 0, scaleX: 1, scaleY: 1, rotation: 0 };

/**
 * Squash-and-stretch plus bob for a walking figure.
 *
 * The body rises between steps and compresses on each footfall, and the
 * squash is volume-preserving (wider when shorter), which is what makes it
 * read as weight rather than as a sprite being scaled.
 *
 * `phase` is 0..1 through one cycle; two footfalls fall at 0.25 and 0.75.
 */
export function walkMotion(phase: number, intensity = 1): MotionTransform {
  const p = wrap01(phase);
  // Two footfalls per cycle → double frequency for the vertical bob.
  const bob = Math.sin(p * Math.PI * 4);
  // The footfall is where the bob is at its lowest; squash tracks that, but
  // only on the downstroke — a figure does not stretch upward off the ground.
  const impact = Math.max(0, -bob);

  const squash = impact * 0.06 * intensity;
  // Negating a zero rise yields -0, which is not `Object.is`-equal to 0 and
  // would make "this figure is not moving" fail an equality check downstream.
  const rise = Math.max(0, bob) * 1.2 * intensity;
  return {
    offsetY: rise === 0 ? 0 : -rise,
    offsetX: 0,
    scaleX: 1 + squash,
    scaleY: 1 - squash,
    rotation: 0,
  };
}

/**
 * The rise and fall of standing still.
 *
 * A figure that is perfectly static reads as a bug. This is the smallest
 * motion that fixes it: a slow vertical breath with a barely-there chest
 * scale, well under the threshold where it looks like an animation.
 */
export function breathMotion(elapsedMs: number, seed = 0): MotionTransform {
  // The seed offsets each figure's phase, so a room full of agents does not
  // breathe in unison like a chorus line.
  const p = wrap01(elapsedMs / BREATH_CYCLE_MS + seed);
  const breath = Math.sin(p * Math.PI * 2);
  return {
    offsetY: -breath * 0.35,
    offsetX: 0,
    scaleX: 1,
    scaleY: 1 + breath * 0.012,
    rotation: 0,
  };
}

/**
 * Whether the eyes are shut this frame.
 *
 * Blinks are irregular — a fixed interval reads as a metronome — so the seed
 * both offsets the phase and varies the interval per figure.
 */
export function isBlinking(elapsedMs: number, seed = 0): boolean {
  const interval = BLINK_INTERVAL_MS * (0.75 + (seed % 1) * 0.5);
  const offset = seed * interval;
  return (elapsedMs + offset) % interval < BLINK_DURATION_MS;
}

/**
 * The lean into travel.
 *
 * A body accelerating leans forward and settles upright at speed. `progress`
 * is 0..1 through the current move; the lean peaks early and decays, which is
 * what separates "set off" from "is moving".
 */
export function leanRotation(progress: number, direction: "left" | "right" | "up" | "down"): number {
  if (direction === "up" || direction === "down") return 0;
  const p = clamp01(progress);
  // Peaks at ~15% into the move, gone by ~60%.
  const lean = Math.max(0, Math.sin(p * Math.PI * 3.3)) * Math.max(0, 1 - p * 1.6);
  const maxLean = 0.06; // radians ≈ 3.4°
  return direction === "right" ? lean * maxLean : -lean * maxLean;
}

/**
 * Eases the last stretch of a walk so a figure settles into a seat instead of
 * stopping dead on the pixel.
 *
 * Returns a speed multiplier for `remaining` pixels of travel. Above the
 * braking distance it is 1 — deceleration should be felt at the destination,
 * not as sluggishness across the room.
 */
export function arrivalSpeedScale(remainingPx: number, brakingPx = 18): number {
  if (remainingPx >= brakingPx) return 1;
  if (remainingPx <= 0) return 0;
  const t = remainingPx / brakingPx;
  // Ease-out cubic, floored so the last pixel is not approached asymptotically.
  return Math.max(0.25, 1 - (1 - t) ** 3);
}

/**
 * The flourish that belongs to a status.
 *
 * These are the moments the office exists to show: an agent that is thinking,
 * one that is blocked on the owner, one that has failed. Each is a distinct
 * shape of motion rather than a colour change, because motion is what the eye
 * catches across a room at a glance.
 */
export function statusMotion(status: AgentStatus, elapsedMs: number, seed = 0): MotionTransform {
  switch (status) {
    case "thinking": {
      // A slow, considered sway — the figure is present but not acting.
      const p = wrap01(elapsedMs / 2200 + seed);
      return { ...NEUTRAL, rotation: Math.sin(p * Math.PI * 2) * 0.035 };
    }
    case "working": {
      // Typing: a fast, small, irregular jitter. Two frequencies that do not
      // divide evenly, so it never settles into a visible loop.
      const a = Math.sin(elapsedMs / 90 + seed * 10);
      const b = Math.sin(elapsedMs / 143 + seed * 7);
      return { ...NEUTRAL, offsetY: (a + b) * 0.22, offsetX: b * 0.15 };
    }
    case "waiting_for_approval":
    case "waiting_for_input": {
      // An impatient bounce, with long pauses between: it should catch the
      // eye periodically, not wave continuously for attention.
      const p = wrap01(elapsedMs / 2600 + seed);
      const burst = p < 0.22 ? Math.sin((p / 0.22) * Math.PI * 3) : 0;
      return { ...NEUTRAL, offsetY: -Math.abs(burst) * 2.2 };
    }
    case "error": {
      // A short shake on a long cycle — visibly wrong, not a seizure.
      const p = wrap01(elapsedMs / 3000 + seed);
      const shake = p < 0.12 ? Math.sin((p / 0.12) * Math.PI * 8) : 0;
      return { ...NEUTRAL, offsetX: shake * 1.6, rotation: shake * 0.02 };
    }
    case "rate_limited": {
      // Slumped and still: the figure is stalled, and looks it.
      return { ...NEUTRAL, offsetY: 0.8, scaleY: 0.985, scaleX: 1.01 };
    }
    case "in_meeting": {
      // A small attentive nod, roughly at conversational pace.
      const p = wrap01(elapsedMs / 3400 + seed);
      const nod = p < 0.3 ? Math.sin((p / 0.3) * Math.PI * 2) : 0;
      return { ...NEUTRAL, offsetY: nod * 0.9 };
    }
    case "paused":
      return NEUTRAL;
    case "idle":
    default:
      return breathMotion(elapsedMs, seed);
  }
}

/**
 * Adds transforms together the way an animator layers them: offsets and
 * rotations sum, scales multiply.
 */
export function combineMotion(...parts: readonly MotionTransform[]): MotionTransform {
  const out: MotionTransform = { ...NEUTRAL };
  for (const p of parts) {
    out.offsetY += p.offsetY;
    out.offsetX += p.offsetX;
    out.scaleX *= p.scaleX;
    out.scaleY *= p.scaleY;
    out.rotation += p.rotation;
  }
  return out;
}

/**
 * A stable per-figure phase offset in 0..1, so identical animations do not run
 * in lockstep across the room.
 */
export function motionSeed(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000) / 1000;
}

function wrap01(v: number): number {
  const r = v % 1;
  return r < 0 ? r + 1 : r;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
