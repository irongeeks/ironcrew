import fs from "node:fs";
import path from "node:path";
import type { PackRegistry } from "../../../packs/pack-registry.ts";

export interface PackArtifact {
  name: string;
  path: string;
  content: string;
  sizeBytes: number;
}

const ARTIFACT_CONTENT_LIMIT = 1500;
const ARTIFACT_PREVIEW_LIMIT = 300;
const BINARY_EXTENSIONS = new Set([
  ".mp4",
  ".avi",
  ".mov",
  ".mkv",
  ".webm",
  ".flv",
  ".mp3",
  ".wav",
  ".ogg",
  ".flac",
  ".aac",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".webp",
  ".tiff",
  ".ico",
  ".svg",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".7z",
  ".rar",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".wasm",
]);

/**
 * Collect output files from terminal phases of a workflow pack.
 * Returns artifacts sorted by size (largest first) with content truncated.
 */
export function collectPackTerminalArtifacts(
  packRegistry: PackRegistry,
  workflowPackKey: string,
  projectPath: string,
  contentLimit = ARTIFACT_CONTENT_LIMIT,
): PackArtifact[] {
  let pack;
  try {
    pack = packRegistry.get(workflowPackKey);
  } catch {
    return [];
  }

  const { terminals, phases } = pack.graph;
  const terminalSet = new Set(terminals);
  const artifacts: PackArtifact[] = [];

  for (const phase of phases) {
    if (!terminalSet.has(phase.id)) continue;
    for (const output of phase.outputs) {
      const absPath = path.isAbsolute(output.path) ? output.path : path.resolve(projectPath, output.path);
      const normalizedPath = path.normalize(absPath);
      const normalizedProject = path.normalize(path.resolve(projectPath));
      if (!normalizedPath.startsWith(normalizedProject + path.sep) && normalizedPath !== normalizedProject) {
        continue;
      }
      try {
        if (!fs.existsSync(absPath)) continue;
        const stat = fs.statSync(absPath);
        if (!stat.isFile()) continue;
        const ext = path.extname(absPath).toLowerCase();
        if (BINARY_EXTENSIONS.has(ext)) {
          artifacts.push({
            name: output.name,
            path: output.path,
            content: `[binary file: ${ext}, ${stat.size} bytes]`,
            sizeBytes: stat.size,
          });
          continue;
        }
        const raw = fs.readFileSync(absPath, "utf8");
        const content = raw.length > contentLimit ? `${raw.slice(0, contentLimit).trimEnd()}\n\n...[truncated]` : raw;
        artifacts.push({
          name: output.name,
          path: output.path,
          content,
          sizeBytes: stat.size,
        });
      } catch {
        // skip unreadable files
      }
    }
  }

  return artifacts.sort((a, b) => b.sizeBytes - a.sizeBytes);
}

/**
 * Build a short artifact summary line for prompts (e.g. "final_report.md (4.2 KB)").
 */
export function formatArtifactSummaryLine(artifacts: PackArtifact[]): string {
  return artifacts.map((a) => `${a.path} (${(a.sizeBytes / 1024).toFixed(1)} KB)`).join(", ");
}

/**
 * Build a preview of the primary artifact (first 300 chars, normalized whitespace).
 */
export function buildArtifactPreview(artifacts: PackArtifact[], maxChars = ARTIFACT_PREVIEW_LIMIT): string {
  if (artifacts.length === 0) return "";
  const primary = artifacts[0];
  const normalized = primary.content.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars).trimEnd()}...`;
}
