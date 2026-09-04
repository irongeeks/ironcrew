import { describe, it, expect } from "vitest";
import {
  BREATH_CYCLE_MS,
  NEUTRAL,
  arrivalSpeedScale,
  breathMotion,
  combineMotion,
  isBlinking,
  leanRotation,
  motionSeed,
  statusMotion,
  walkMotion,
} from "./character-motion.ts";
import { MOTION_STATUSES, toMotionStatus, wandersWhenIdle } from "./motion-status.ts";

/** Samples one cycle of a motion function at a fixed resolution. */
function sample(fn: (t: number) => number, cycleMs: number, steps = 120): number[] {
  return Array.from({ length: steps }, (_, i) => fn((i / steps) * cycleMs));
}

describe("walkMotion", () => {
  it("squashes and stretches while preserving volume", () => {
    for (let i = 0; i <= 20; i++) {
      const m = walkMotion(i / 20);
      // Wider exactly when shorter — that is what reads as weight rather
      // than as a sprite being scaled.
      if (m.scaleY < 1) expect(m.scaleX).toBeGreaterThan(1);
      if (m.scaleY > 1) expect(m.scaleX).toBeLessThan(1);
    }
  });

  it("stays within a believable range", () => {
    for (let i = 0; i <= 60; i++) {
      const m = walkMotion(i / 60);
      expect(Math.abs(1 - m.scaleX)).toBeLessThan(0.1);
      expect(Math.abs(1 - m.scaleY)).toBeLessThan(0.1);
      expect(Math.abs(m.offsetY)).toBeLessThan(2);
    }
  });

  it("bobs twice per cycle — one rise per footfall", () => {
    const ys = sample((t) => walkMotion(t).offsetY, 1);
    let peaks = 0;
    for (let i = 1; i < ys.length - 1; i++) {
      // offsetY is negative for "up", so a peak is a local minimum.
      if (ys[i] < ys[i - 1] && ys[i] < ys[i + 1]) peaks++;
    }
    expect(peaks).toBe(2);
  });

  it("loops seamlessly", () => {
    const start = walkMotion(0);
    const end = walkMotion(1);
    expect(end.offsetY).toBeCloseTo(start.offsetY, 5);
    expect(end.scaleY).toBeCloseTo(start.scaleY, 5);
  });

  it("scales with intensity, and vanishes at zero", () => {
    // Sampled at the top of the bob (phase 0.125); at the bottom the rise is
    // zero at every intensity, which would make the comparison meaningless.
    const full = walkMotion(0.125, 1);
    const half = walkMotion(0.125, 0.5);
    expect(Math.abs(half.offsetY)).toBeLessThan(Math.abs(full.offsetY));
    expect(walkMotion(0.125, 0)).toEqual(NEUTRAL);
  });

  it("handles a phase outside 0..1 rather than producing garbage", () => {
    expect(walkMotion(2.25)).toEqual(walkMotion(0.25));
    expect(walkMotion(-0.75).offsetY).toBeCloseTo(walkMotion(0.25).offsetY, 10);
  });
});

describe("breathMotion", () => {
  it("is small enough to read as alive, not as animated", () => {
    for (let t = 0; t < BREATH_CYCLE_MS; t += 60) {
      const m = breathMotion(t);
      expect(Math.abs(m.offsetY)).toBeLessThanOrEqual(0.4);
      expect(Math.abs(1 - m.scaleY)).toBeLessThan(0.02);
    }
  });

  it("gives each figure its own phase, so a room does not breathe in unison", () => {
    const a = breathMotion(1000, motionSeed("agt_1"));
    const b = breathMotion(1000, motionSeed("agt_2"));
    expect(a.offsetY).not.toBeCloseTo(b.offsetY, 3);
  });
});

describe("isBlinking", () => {
  it("blinks rarely and briefly", () => {
    let blinks = 0;
    const stepMs = 10;
    const windowMs = 60_000;
    for (let t = 0; t < windowMs; t += stepMs) {
      if (isBlinking(t, 0.3)) blinks++;
    }
    const fractionShut = (blinks * stepMs) / windowMs;
    // Eyes shut a few percent of the time — felt, not seen.
    expect(fractionShut).toBeGreaterThan(0.005);
    expect(fractionShut).toBeLessThan(0.06);
  });

  it("does not blink in unison across figures", () => {
    const seeds = ["a", "b", "c", "d", "e"].map(motionSeed);
    let sameFrameCount = 0;
    for (let t = 0; t < 20_000; t += 50) {
      const states = seeds.map((s) => isBlinking(t, s));
      if (states.every((s) => s === states[0]) && states[0]) sameFrameCount++;
    }
    expect(sameFrameCount).toBe(0);
  });
});

describe("leanRotation", () => {
  it("leans into the direction of travel", () => {
    expect(leanRotation(0.15, "right")).toBeGreaterThan(0);
    expect(leanRotation(0.15, "left")).toBeLessThan(0);
  });

  it("does not lean when moving toward or away from the viewer", () => {
    expect(leanRotation(0.15, "up")).toBe(0);
    expect(leanRotation(0.15, "down")).toBe(0);
  });

  it("peaks early and settles upright", () => {
    const early = Math.abs(leanRotation(0.15, "right"));
    const late = Math.abs(leanRotation(0.9, "right"));
    expect(early).toBeGreaterThan(late);
    expect(late).toBeLessThan(0.005);
  });

  it("stays a lean, never a tumble", () => {
    for (let i = 0; i <= 100; i++) {
      expect(Math.abs(leanRotation(i / 100, "right"))).toBeLessThan(0.07);
    }
  });

  it("clamps a progress value outside 0..1", () => {
    expect(leanRotation(-1, "right")).toBe(leanRotation(0, "right"));
    expect(leanRotation(5, "right")).toBe(leanRotation(1, "right"));
  });
});

describe("arrivalSpeedScale", () => {
  it("does not slow the figure down across the room", () => {
    expect(arrivalSpeedScale(200)).toBe(1);
    expect(arrivalSpeedScale(18)).toBe(1);
  });

  it("eases into the destination", () => {
    expect(arrivalSpeedScale(14)).toBeLessThan(1);
    expect(arrivalSpeedScale(4)).toBeLessThan(arrivalSpeedScale(14));
  });

  it("keeps a floor, so the last pixel is actually reached", () => {
    // Without this the figure approaches its seat asymptotically and never
    // arrives — the walk animation would never end.
    expect(arrivalSpeedScale(0.01)).toBeGreaterThan(0.2);
    expect(arrivalSpeedScale(0)).toBe(0);
  });
});

describe("statusMotion", () => {
  it("gives every status a defined motion", () => {
    for (const status of MOTION_STATUSES) {
      const m = statusMotion(status, 1234, 0.5);
      expect(Number.isFinite(m.offsetX)).toBe(true);
      expect(Number.isFinite(m.offsetY)).toBe(true);
      expect(Number.isFinite(m.rotation)).toBe(true);
      expect(m.scaleX).toBeGreaterThan(0);
      expect(m.scaleY).toBeGreaterThan(0);
    }
  });

  it("distinguishes the statuses the eye needs to catch across a room", () => {
    // Several statuses are deliberately bursty — a shake or a bounce inside a
    // long quiet cycle — so the window has to span more than one full cycle
    // of the slowest of them, or the sampling misses the motion entirely.
    const at = (s: (typeof MOTION_STATUSES)[number]) =>
      Array.from({ length: 250 }, (_, i) => statusMotion(s, i * 40, 0.2));
    const spread = (ms: ReturnType<typeof at>) =>
      Math.max(...ms.map((m) => Math.abs(m.offsetY) + Math.abs(m.offsetX) + Math.abs(m.rotation) * 20));

    // Each of these must actually move; a status that reads as "nothing is
    // happening" defeats the point of showing it.
    expect(spread(at("working"))).toBeGreaterThan(0.1);
    expect(spread(at("waiting_for_approval"))).toBeGreaterThan(0.5);
    expect(spread(at("error"))).toBeGreaterThan(0.5);
    expect(spread(at("thinking"))).toBeGreaterThan(0.1);
  });

  it("holds a paused figure completely still", () => {
    expect(statusMotion("paused", 5000, 0.4)).toEqual(NEUTRAL);
  });

  it("slumps a rate-limited figure rather than animating it", () => {
    const m = statusMotion("rate_limited", 5000, 0.4);
    expect(m.offsetY).toBeGreaterThan(0); // downward — stalled, and looks it
    expect(m.scaleY).toBeLessThan(1);
  });

  it("keeps every flourish subtle enough not to break the tile grid", () => {
    for (const status of MOTION_STATUSES) {
      for (let t = 0; t < 6000; t += 40) {
        const m = statusMotion(status, t, 0.7);
        expect(Math.abs(m.offsetY)).toBeLessThan(4);
        expect(Math.abs(m.offsetX)).toBeLessThan(4);
        expect(Math.abs(m.rotation)).toBeLessThan(0.06);
      }
    }
  });
});

describe("combineMotion", () => {
  it("layers offsets additively and scales multiplicatively", () => {
    const a = { offsetY: -1, offsetX: 2, scaleX: 1.1, scaleY: 0.9, rotation: 0.01 };
    const b = { offsetY: -2, offsetX: 1, scaleX: 1.2, scaleY: 0.8, rotation: 0.02 };
    const c = combineMotion(a, b);

    expect(c.offsetY).toBeCloseTo(-3);
    expect(c.offsetX).toBeCloseTo(3);
    expect(c.scaleX).toBeCloseTo(1.32);
    expect(c.scaleY).toBeCloseTo(0.72);
    expect(c.rotation).toBeCloseTo(0.03);
  });

  it("is a no-op for neutral parts", () => {
    expect(combineMotion(NEUTRAL, NEUTRAL)).toEqual(NEUTRAL);
    expect(combineMotion()).toEqual(NEUTRAL);
  });
});

describe("motionSeed", () => {
  it("is stable for the same key", () => {
    expect(motionSeed("agt_abc")).toBe(motionSeed("agt_abc"));
  });

  it("spreads keys across the 0..1 range", () => {
    const seeds = Array.from({ length: 40 }, (_, i) => motionSeed(`agt_${i}`));
    expect(new Set(seeds).size).toBeGreaterThan(30);
    for (const s of seeds) {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(1);
    }
  });
});

describe("toMotionStatus", () => {
  it("passes IronCrew's own statuses through", () => {
    for (const status of MOTION_STATUSES) {
      expect(toMotionStatus(status)).toBe(status);
    }
  });

  it("maps the upstream office's 'break' onto idle", () => {
    expect(toMotionStatus("break")).toBe("idle");
  });

  it("falls back to idle for anything unrecognised", () => {
    // A figure that stands and breathes is the right answer to "we do not
    // know what this one is doing".
    expect(toMotionStatus("nonsense")).toBe("idle");
    expect(toMotionStatus(null)).toBe("idle");
    expect(toMotionStatus(undefined)).toBe("idle");
  });
});

describe("wandersWhenIdle", () => {
  it("lets only genuinely unoccupied figures wander", () => {
    expect(wandersWhenIdle("idle")).toBe(true);
    // An office where everyone drifts reads as a screensaver, not a company.
    expect(wandersWhenIdle("working")).toBe(false);
    expect(wandersWhenIdle("in_meeting")).toBe(false);
    expect(wandersWhenIdle("waiting_for_approval")).toBe(false);
  });
});
