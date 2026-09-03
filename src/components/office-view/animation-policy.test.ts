import { describe, it, expect } from "vitest";
import { tickerStepEnabled, particleOpacityFor } from "./animation-policy";

describe("tickerStepEnabled", () => {
  it("enables every animation branch when reduced-motion is false", () => {
    const policy = tickerStepEnabled(false);
    expect(policy.wander).toBe(true);
    expect(policy.move).toBe(true);
    expect(policy.walkCycle).toBe(true);
    expect(policy.headBob).toBe(true);
    expect(policy.typingJitter).toBe(true);
  });

  it("disables every animation branch when reduced-motion is true", () => {
    const policy = tickerStepEnabled(true);
    expect(policy.wander).toBe(false);
    expect(policy.move).toBe(false);
    expect(policy.walkCycle).toBe(false);
    expect(policy.headBob).toBe(false);
    expect(policy.typingJitter).toBe(false);
  });

  it("gates wander (random target picking) when reduced-motion is true", () => {
    expect(tickerStepEnabled(true).wander).toBe(false);
    expect(tickerStepEnabled(false).wander).toBe(true);
  });

  it("gates move (per-tick path-following) when reduced-motion is true", () => {
    expect(tickerStepEnabled(true).move).toBe(false);
    expect(tickerStepEnabled(false).move).toBe(true);
  });
});

describe("particleOpacityFor", () => {
  it("returns the supplied default opacity when reduced-motion is false", () => {
    expect(particleOpacityFor(false, 0.6)).toBe(0.6);
    expect(particleOpacityFor(false, 1)).toBe(1);
  });

  it("collapses opacity to 0 when reduced-motion is true", () => {
    expect(particleOpacityFor(true, 0.6)).toBe(0);
    expect(particleOpacityFor(true, 1)).toBe(0);
  });
});
