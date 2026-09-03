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
// remotionGate — pre-run hook for the assembly phase
//
// Checks whether the video_output/clips/ directory exists and contains at
// least one non-empty .mp4 clip file.  If clips are present the hook returns
// ok: true so the assembly phase can proceed.  If no clips are found it
// returns ok: false with an explanatory message so the graph-runner can hold
// the phase until the prerequisite is met.
// ---------------------------------------------------------------------------

export const remotionGate: HookFunction = async (context: HookContext) => {
  const { rootDir } = context;
  const clipsDir = path.join(rootDir, "video_output", "clips");

  if (!fs.existsSync(clipsDir)) {
    return {
      ok: false,
      message: `Assembly pre-run gate: clips directory not found at ${clipsDir}`,
    };
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(clipsDir, { withFileTypes: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `Assembly pre-run gate: failed to read clips directory — ${msg}` };
  }

  const clips = entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".mp4"));

  if (clips.length === 0) {
    return {
      ok: false,
      message: `Assembly pre-run gate: no .mp4 clips found in ${clipsDir}`,
    };
  }

  // Verify at least one clip is non-empty
  const hasNonEmpty = clips.some((entry) => {
    try {
      return fs.statSync(path.join(clipsDir, entry.name)).size > 0;
    } catch {
      return false;
    }
  });

  if (!hasNonEmpty) {
    return {
      ok: false,
      message: `Assembly pre-run gate: all clips in ${clipsDir} are empty`,
    };
  }

  return { ok: true };
};

export default remotionGate;
