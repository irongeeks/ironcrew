import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Hook interface (matches graph-runner expectations)
// ---------------------------------------------------------------------------

export interface HookContext {
  taskId: string;
  subtaskId: string;
  packKey: string;
  phaseId: string;
  rootDir: string;
  db: unknown;
}

export type HookFunction = (context: HookContext) => Promise<{ ok: boolean; message?: string }>;

// ---------------------------------------------------------------------------
// probeVideoArtifact — post-run hook for the assembly phase
//
// Checks whether video_output/final.mp4 exists in rootDir and is non-empty.
// Returns ok: true when the artifact is present and non-empty, otherwise
// returns ok: false with a descriptive message so the graph-runner can flag
// the phase as needing attention.
// ---------------------------------------------------------------------------

export const probeVideoArtifact: HookFunction = async (context: HookContext) => {
  const { rootDir } = context;
  const finalVideoPath = path.join(rootDir, "video_output", "final.mp4");

  if (!fs.existsSync(finalVideoPath)) {
    return {
      ok: false,
      message: `Video artifact missing: expected ${finalVideoPath}`,
    };
  }

  let size: number;
  try {
    size = fs.statSync(finalVideoPath).size;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `Video artifact stat failed: ${msg}` };
  }

  if (size === 0) {
    return {
      ok: false,
      message: `Video artifact is empty (0 bytes): ${finalVideoPath}`,
    };
  }

  return { ok: true };
};

export default probeVideoArtifact;
