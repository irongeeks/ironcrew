import fs from "node:fs";
import path from "node:path";

type DesignAssetCategory = "mockup" | "screenshot" | "token";

const DESIGN_SOURCE_DIR_CANDIDATES = [
  "design_output",
  "design-assets",
  "design_assets",
  "screenshots",
  "tokens",
  "assets/design",
];

const DESIGN_FILE_CATEGORY_BY_EXT: Record<string, DesignAssetCategory> = {
  ".png": "mockup",
  ".jpg": "mockup",
  ".jpeg": "mockup",
  ".webp": "mockup",
  ".svg": "mockup",
  ".pdf": "mockup",
  ".gif": "screenshot",
  ".json": "token",
  ".yaml": "token",
  ".yml": "token",
  ".css": "token",
  ".scss": "token",
};

function walkFiles(dir: string, out: string[]): void {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, out);
      continue;
    }
    if (entry.isFile()) out.push(full);
  }
}

function categorizeFile(filePath: string): DesignAssetCategory | null {
  const ext = path.extname(filePath).toLowerCase();
  return DESIGN_FILE_CATEGORY_BY_EXT[ext] ?? null;
}

function safeRelative(base: string, target: string): string {
  const relative = path.relative(base, target).replace(/\\/g, "/");
  if (!relative || relative.startsWith("..")) {
    return path.basename(target);
  }
  return relative;
}

export function syncDesignArtifactsFromWorktree(params: {
  taskId: string;
  worktreePath: string;
  projectPath: string;
  nowMs: number;
}): {
  copiedCount: number;
  outputDir: string;
  manifest: Array<{ category: DesignAssetCategory; relativePath: string; bytes: number }>;
} {
  const { taskId, worktreePath, projectPath, nowMs } = params;
  const destRoot = path.join(projectPath, "design_output", `task-${taskId.slice(0, 8)}`);
  const sourceFiles: string[] = [];

  for (const candidate of DESIGN_SOURCE_DIR_CANDIDATES) {
    const sourceDir = path.join(worktreePath, candidate);
    if (!fs.existsSync(sourceDir)) continue;
    walkFiles(sourceDir, sourceFiles);
  }

  const manifest: Array<{ category: DesignAssetCategory; relativePath: string; bytes: number }> = [];
  let copiedCount = 0;

  for (const sourceFile of sourceFiles) {
    const category = categorizeFile(sourceFile);
    if (!category) continue;

    let stat: fs.Stats;
    try {
      stat = fs.statSync(sourceFile);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size <= 0) continue;

    const rel = safeRelative(worktreePath, sourceFile);
    const destPath = path.join(destRoot, rel);
    try {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.copyFileSync(sourceFile, destPath);
      const destRel = safeRelative(projectPath, destPath);
      manifest.push({ category, relativePath: destRel, bytes: stat.size });
      copiedCount += 1;
    } catch {
      // Ignore copy failures and continue with remaining files.
    }
  }

  if (copiedCount > 0) {
    try {
      const manifestPath = path.join(destRoot, "manifest.json");
      fs.writeFileSync(
        manifestPath,
        JSON.stringify(
          {
            taskId,
            generatedAt: nowMs,
            copiedCount,
            files: manifest,
          },
          null,
          2,
        ),
        "utf8",
      );
    } catch {
      // Best-effort manifest write only.
    }
  }

  return {
    copiedCount,
    outputDir: safeRelative(projectPath, destRoot),
    manifest,
  };
}
