/**
 * What this machine can actually draw, and what the office should draw because
 * of it.
 *
 * The office is a WebGL scene. On a workstation with a discrete GPU that is
 * free; on integrated graphics it is fine; under a software rasteriser
 * (SwiftShader, llvmpipe — VMs, remote desktops, locked-down enterprise
 * browsers) the same scene renders at single-digit frames per second, and on a
 * machine with no WebGL at all it does not render.
 *
 * So quality is not a user setting to get wrong. It is measured:
 *
 *  1. **Before the first frame** — `detectRenderTier()` reads what the driver
 *     says it is and picks a starting tier. This is a guess, and a good one:
 *     a software rasteriser names itself.
 *  2. **From real frame times** — `adaptTier()` watches how long frames
 *     actually take and moves between tiers. A guess that was wrong costs a
 *     second of stutter, not the session.
 *
 * Everything here is a pure function of its inputs, so the policy is tested
 * without booting Pixi or owning a slow GPU.
 */

/**
 * Ordered worst → best. `none` is not a quality level but an answer: this
 * browser cannot run the scene, and the caller must show something else
 * rather than an empty box.
 */
export const RENDER_TIERS = ["none", "low", "balanced", "high"] as const;
export type RenderTier = (typeof RENDER_TIERS)[number];

/** What the browser told us about itself. */
export interface RenderCapabilities {
  /** `WEBGL_debug_renderer_info`'s UNMASKED_RENDERER_WEBGL, or "" if withheld. */
  renderer: string;
  /** False when `getContext("webgl2"|"webgl")` returned nothing at all. */
  webgl: boolean;
  devicePixelRatio: number;
  /** `navigator.hardwareConcurrency`, or 0 when unavailable. */
  cores: number;
  /** `navigator.deviceMemory` in GB, or 0 when unavailable (Safari, Firefox). */
  memoryGb: number;
}

/** The knobs a tier actually turns. */
export interface RenderQuality {
  tier: RenderTier;
  /**
   * Cap on the canvas backing-store scale. Fill rate is the first thing to go
   * on weak hardware, and a 4K screen at dpr 2 asks for four times the pixels
   * of dpr 1 — so this is the single most effective knob, and the one that
   * costs the least visually on a pixel-art scene.
   */
  resolution: number;
  /** Ambient dust particles. 0 disables the layer's work entirely. */
  particles: number;
  /** Per-agent drop shadows and desk-lamp pools (extra transparent overdraw). */
  shadows: boolean;
  /** The richer per-agent motion: squash, lean, breathing, blinking. */
  characterFlourish: boolean;
  /** Ticker cap. 30 fps that holds beats 60 fps that stutters. */
  maxFps: number;
  /** Anti-aliasing is pure fill-rate cost, and pixel art does not want it. */
  antialias: boolean;
}

/** Substrings a software rasteriser or a known-weak stack identifies itself by. */
const SOFTWARE_RENDERERS = ["swiftshader", "llvmpipe", "softpipe", "software", "microsoft basic render", "gdi generic"];

/** Integrated graphics: real hardware, real limits. */
const INTEGRATED_RENDERERS = [
  "intel",
  "uhd graphics",
  "hd graphics",
  "iris",
  "vega",
  "radeon graphics",
  "mali",
  "adreno",
  "videocore",
];

function includesAny(haystack: string, needles: readonly string[]): boolean {
  return needles.some((n) => haystack.includes(n));
}

/**
 * Picks the tier to start at. Deliberately pessimistic where the signal is
 * ambiguous: starting low and being promoted by `adaptTier()` after a second
 * of smooth frames is a better first impression than starting high and
 * stuttering.
 */
export function detectRenderTier(caps: RenderCapabilities): RenderTier {
  if (!caps.webgl) return "none";

  const renderer = caps.renderer.toLowerCase();

  // A software rasteriser names itself, and no amount of turning knobs down
  // makes a full-scene WebGL office pleasant on one.
  if (includesAny(renderer, SOFTWARE_RENDERERS)) return "low";

  // Very small machines, whatever the GPU claims.
  if (caps.cores > 0 && caps.cores <= 2) return "low";
  if (caps.memoryGb > 0 && caps.memoryGb <= 2) return "low";

  if (includesAny(renderer, INTEGRATED_RENDERERS)) return "balanced";

  // An empty renderer string is the common case in privacy-hardened browsers,
  // not a signal of weakness — fall back to the coarse machine signals.
  if (renderer === "") {
    if (caps.cores >= 8 && caps.devicePixelRatio <= 2) return "high";
    return "balanced";
  }

  return "high";
}

/** The concrete settings for a tier. */
export function qualityForTier(tier: RenderTier, devicePixelRatio = 1): RenderQuality {
  const dpr = devicePixelRatio > 0 ? devicePixelRatio : 1;
  switch (tier) {
    case "none":
      // Nothing renders; the values still have to be coherent so a caller
      // that ignores the tier does not divide by zero somewhere.
      return {
        tier,
        resolution: 1,
        particles: 0,
        shadows: false,
        characterFlourish: false,
        maxFps: 0,
        antialias: false,
      };
    case "low":
      return {
        tier,
        resolution: 1,
        particles: 0,
        shadows: false,
        // Flourish stays ON: it is arithmetic on sprites that already exist,
        // costing no extra draw calls or fill rate. It is what keeps the low
        // tier looking alive rather than merely cheap.
        characterFlourish: true,
        maxFps: 30,
        antialias: false,
      };
    case "balanced":
      return {
        tier,
        resolution: Math.min(dpr, 1.5),
        particles: 24,
        shadows: true,
        characterFlourish: true,
        maxFps: 60,
        antialias: false,
      };
    case "high":
      return {
        tier,
        resolution: Math.min(dpr, 2),
        particles: 60,
        shadows: true,
        characterFlourish: true,
        maxFps: 60,
        antialias: false,
      };
  }
}

/** Frame-time thresholds, in milliseconds per frame. */
const DEMOTE_ABOVE_MS = 28; // sustained worse than ~36 fps
const PROMOTE_BELOW_MS = 13; // sustained better than ~77 fps
/** Samples needed before either verdict — one bad frame is not a trend. */
export const ADAPT_SAMPLE_SIZE = 45;

export interface AdaptDecision {
  tier: RenderTier;
  /** Why it changed, for the operator-facing readout. Empty when unchanged. */
  reason: string;
}

/**
 * Moves between tiers based on measured frame times.
 *
 * Demotion is eager (one sustained bad window is enough) and promotion is
 * conservative (only from `low`, and only after a clearly comfortable window),
 * because oscillating between tiers is worse than sitting one tier below the
 * best a machine could manage. `none` never adapts: no WebGL is not a
 * performance problem to be tuned around.
 */
export function adaptTier(current: RenderTier, frameTimesMs: readonly number[]): AdaptDecision {
  if (current === "none") return { tier: current, reason: "" };
  if (frameTimesMs.length < ADAPT_SAMPLE_SIZE) return { tier: current, reason: "" };

  const recent = frameTimesMs.slice(-ADAPT_SAMPLE_SIZE);
  // The median, not the mean: one 300 ms hitch from a garbage collection or a
  // texture upload should not condemn a machine that is otherwise smooth.
  const median = [...recent].sort((a, b) => a - b)[Math.floor(recent.length / 2)];

  if (median > DEMOTE_ABOVE_MS) {
    const next: RenderTier = current === "high" ? "balanced" : "low";
    if (next === current) return { tier: current, reason: "" };
    return { tier: next, reason: `${Math.round(1000 / median)} fps gemessen — Qualität reduziert.` };
  }

  if (current === "low" && median < PROMOTE_BELOW_MS) {
    return { tier: "balanced", reason: `${Math.round(1000 / median)} fps gemessen — Qualität erhöht.` };
  }

  return { tier: current, reason: "" };
}

/**
 * Asks the browser what it can do, without leaving a context behind.
 *
 * Every step is guarded: a browser may refuse `getContext`, withhold
 * `WEBGL_debug_renderer_info`, or throw on `navigator` fields that do not
 * exist. Any of those means "unknown", never "broken".
 */
export function probeRenderCapabilities(): RenderCapabilities {
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  const caps: RenderCapabilities = {
    renderer: "",
    webgl: false,
    devicePixelRatio: typeof window === "undefined" ? 1 : window.devicePixelRatio || 1,
    cores: nav?.hardwareConcurrency ?? 0,
    memoryGb: (nav as { deviceMemory?: number } | undefined)?.deviceMemory ?? 0,
  };

  if (typeof document === "undefined") return caps;

  let canvas: HTMLCanvasElement | null = null;
  let gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;
  try {
    canvas = document.createElement("canvas");
    gl = (canvas.getContext("webgl2") ?? canvas.getContext("webgl")) as WebGL2RenderingContext | null;
    if (!gl) return caps;
    caps.webgl = true;

    const ext = gl.getExtension("WEBGL_debug_renderer_info") as { UNMASKED_RENDERER_WEBGL: number } | null;
    if (ext) {
      const value = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
      if (typeof value === "string") caps.renderer = value;
    }
  } catch {
    // A browser that throws here has told us enough: treat it as unknown
    // rather than letting the probe take the office down with it.
  } finally {
    // Contexts are a scarce resource (browsers cap them at ~16); losing this
    // one deliberately means the probe cannot starve the real renderer.
    try {
      const lose = gl?.getExtension("WEBGL_lose_context") as { loseContext(): void } | null;
      lose?.loseContext();
    } catch {
      /* nothing to release */
    }
    canvas = null;
  }

  return caps;
}
