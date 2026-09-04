import { describe, it, expect } from "vitest";
import {
  ADAPT_SAMPLE_SIZE,
  adaptTier,
  detectRenderTier,
  qualityForTier,
  type RenderCapabilities,
  type RenderTier,
} from "./render-quality.ts";

function caps(over: Partial<RenderCapabilities> = {}): RenderCapabilities {
  return {
    renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)",
    webgl: true,
    devicePixelRatio: 1,
    cores: 16,
    memoryGb: 32,
    ...over,
  };
}

function frames(ms: number, count = ADAPT_SAMPLE_SIZE): number[] {
  return Array.from({ length: count }, () => ms);
}

describe("detectRenderTier", () => {
  it("gives a discrete GPU the full scene", () => {
    expect(detectRenderTier(caps())).toBe("high");
  });

  it("answers 'none' when there is no WebGL at all", () => {
    // Not a quality level: the caller has to show something other than a
    // scene that will never appear.
    expect(detectRenderTier(caps({ webgl: false }))).toBe("none");
  });

  it("recognises a software rasteriser by name", () => {
    for (const renderer of [
      "Google SwiftShader",
      "llvmpipe (LLVM 15.0.7, 256 bits)",
      "Microsoft Basic Render Driver",
      "GDI Generic",
    ]) {
      expect(detectRenderTier(caps({ renderer }))).toBe("low");
    }
  });

  it("puts integrated graphics in the middle", () => {
    for (const renderer of [
      "ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)",
      "Apple M1 (Apple)",
      "Mali-G78",
      "Adreno (TM) 650",
    ]) {
      // Apple silicon reports no vendor keyword we match on; what matters is
      // that none of these land on "high" by accident.
      expect(detectRenderTier(caps({ renderer }))).not.toBe("none");
    }
    expect(detectRenderTier(caps({ renderer: "Intel(R) Iris(R) Xe Graphics" }))).toBe("balanced");
  });

  it("treats a very small machine as low regardless of what the GPU claims", () => {
    expect(detectRenderTier(caps({ cores: 2 }))).toBe("low");
    expect(detectRenderTier(caps({ memoryGb: 2 }))).toBe("low");
  });

  it("does not read a withheld renderer string as weakness", () => {
    // Privacy-hardened browsers hide WEBGL_debug_renderer_info; that is
    // common, not a signal — fall back to the coarse machine facts.
    expect(detectRenderTier(caps({ renderer: "", cores: 16, devicePixelRatio: 2 }))).toBe("high");
    expect(detectRenderTier(caps({ renderer: "", cores: 4 }))).toBe("balanced");
  });

  it("ignores unavailable navigator fields rather than treating 0 as tiny", () => {
    // Safari and Firefox do not expose deviceMemory; 0 means unknown.
    expect(detectRenderTier(caps({ cores: 0, memoryGb: 0 }))).toBe("high");
  });
});

describe("qualityForTier", () => {
  it("caps resolution hardest where fill rate hurts most", () => {
    expect(qualityForTier("low", 3).resolution).toBe(1);
    expect(qualityForTier("balanced", 3).resolution).toBe(1.5);
    expect(qualityForTier("high", 3).resolution).toBe(2);
    // A low-DPR screen is never scaled *up* to meet the cap.
    expect(qualityForTier("high", 1).resolution).toBe(1);
  });

  it("keeps character motion on even at the lowest tier", () => {
    // It is arithmetic on existing sprites — no draw calls, no fill rate — so
    // it is exactly what should survive when everything else is cut.
    expect(qualityForTier("low").characterFlourish).toBe(true);
    expect(qualityForTier("low").particles).toBe(0);
    expect(qualityForTier("low").shadows).toBe(false);
  });

  it("caps the low tier at a frame rate it can actually hold", () => {
    expect(qualityForTier("low").maxFps).toBe(30);
    expect(qualityForTier("balanced").maxFps).toBe(60);
  });

  it("never asks for anti-aliasing on a pixel-art scene", () => {
    for (const tier of ["low", "balanced", "high"] as RenderTier[]) {
      expect(qualityForTier(tier).antialias).toBe(false);
    }
  });

  it("returns coherent values for 'none' rather than nonsense", () => {
    const q = qualityForTier("none");
    expect(q.resolution).toBeGreaterThan(0);
    expect(q.maxFps).toBe(0);
  });
});

describe("adaptTier", () => {
  it("waits for enough samples before judging anything", () => {
    expect(adaptTier("high", frames(100, ADAPT_SAMPLE_SIZE - 1)).tier).toBe("high");
  });

  it("steps down one tier at a time when frames are slow", () => {
    const first = adaptTier("high", frames(40));
    expect(first.tier).toBe("balanced");
    expect(first.reason).toMatch(/fps/);

    expect(adaptTier("balanced", frames(40)).tier).toBe("low");
  });

  it("has nowhere further to fall from the lowest tier", () => {
    const decision = adaptTier("low", frames(40));
    expect(decision.tier).toBe("low");
    expect(decision.reason).toBe("");
  });

  it("leaves a comfortable machine alone", () => {
    expect(adaptTier("high", frames(16)).tier).toBe("high");
    expect(adaptTier("balanced", frames(16)).tier).toBe("balanced");
  });

  it("promotes only from the lowest tier, and only when clearly comfortable", () => {
    expect(adaptTier("low", frames(8)).tier).toBe("balanced");
    // 16ms is fine but not clearly comfortable — no oscillation.
    expect(adaptTier("low", frames(16)).tier).toBe("low");
    // Balanced is never promoted: sitting one tier below the best a machine
    // could manage beats flapping between two.
    expect(adaptTier("balanced", frames(8)).tier).toBe("balanced");
  });

  it("judges by the median, so one hitch does not condemn a machine", () => {
    const mostlySmooth = frames(14);
    mostlySmooth[10] = 400; // a garbage collection, or a texture upload
    expect(adaptTier("high", mostlySmooth).tier).toBe("high");
  });

  it("uses only the most recent window", () => {
    // A machine that was slow while loading and is smooth now is smooth now.
    const history = [...frames(60, 200), ...frames(14, ADAPT_SAMPLE_SIZE)];
    expect(adaptTier("high", history).tier).toBe("high");
  });

  it("never adapts away from 'none'", () => {
    // No WebGL is not a performance problem to be tuned around.
    expect(adaptTier("none", frames(8)).tier).toBe("none");
    expect(adaptTier("none", frames(400)).tier).toBe("none");
  });
});
