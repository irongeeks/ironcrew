import { syncDesignArtifactsFromWorktree } from "./design-asset.ts";

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
// syncDesignAssets — post-run hook for the design_execution phase
//
// Wraps syncDesignArtifactsFromWorktree() to collect and copy design output
// files (mockups, tokens, screenshots) produced during the design phase.
// When rootDir is a worktree path, assets are copied into design_output/ under
// the same rootDir.  Returns ok: true with a count of synced files.
// ---------------------------------------------------------------------------

export const syncDesignAssets: HookFunction = async (context: HookContext) => {
  const { taskId, rootDir } = context;

  const result = syncDesignArtifactsFromWorktree({
    taskId,
    worktreePath: rootDir,
    projectPath: rootDir,
    nowMs: Date.now(),
  });

  return {
    ok: true,
    message: `Design assets synced: ${result.copiedCount} file(s) copied to ${result.outputDir}`,
  };
};

export default syncDesignAssets;
