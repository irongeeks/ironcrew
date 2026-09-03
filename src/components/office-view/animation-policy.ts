/**
 * Per-tick animation policy for the Pixi office view.
 *
 * Extracted out of `usePixiApp` so the reduced-motion branching is unit-testable
 * without booting Pixi.js. The Pixi ticker calls `tickerStepEnabled()` once per
 * frame (or on hook re-evaluation) and routes each animated dimension through
 * the resulting flags.
 */
export interface TickerPolicy {
  /** Wander timer for break/idle agents (random target picking + walk-out). */
  wander: boolean;
  /**
   * Per-tick path-following movement (incremental sprite.x/y updates along
   * waypoints). When `false`, sprites freeze at their current position even if
   * a path is queued — used under reduced-motion to suppress continuous canvas
   * motion.
   */
  move: boolean;
  /** Walk-cycle frame ping-pong (0→1→2→1) — sprite frame swapping while moving. */
  walkCycle: boolean;
  /** Idle/walking head-bob sine offset on the body sprite Y axis. */
  headBob: boolean;
  /** Sub-second irregular typing jitter applied to seated working agents. */
  typingJitter: boolean;
}

/**
 * Returns which ticker animation branches should run for the current frame.
 *
 * When `reducedMotion` is true (user has set OS-level
 * `prefers-reduced-motion: reduce`), every branch collapses to `false` so
 * sprites freeze at their idle frame and no continuous canvas motion plays.
 */
export function tickerStepEnabled(reducedMotion: boolean): TickerPolicy {
  if (reducedMotion) {
    return {
      wander: false,
      move: false,
      walkCycle: false,
      headBob: false,
      typingJitter: false,
    };
  }
  return {
    wander: true,
    move: true,
    walkCycle: true,
    headBob: true,
    typingJitter: true,
  };
}

/**
 * Returns the alpha/opacity to use for ambient particles and pulse halos given
 * the current reduced-motion preference. When reduced-motion is on, particles
 * collapse to invisible (no flicker, no drift) instead of being despawned, so
 * the rest of the pipeline can keep its bookkeeping intact.
 */
export function particleOpacityFor(reducedMotion: boolean, defaultOpacity: number): number {
  return reducedMotion ? 0 : defaultOpacity;
}
