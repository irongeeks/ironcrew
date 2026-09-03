import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import type { RuntimeContext } from "../../../types/runtime-context.ts";
import { logger } from "../../../observability/logger.ts";

const log = logger.child({ module: "task-browse" });

interface DirEntry {
  name: string;
  type: "file" | "directory";
  size: number;
  gitStatus: string | null;
}

interface FileTypeInfo {
  type: "text" | "markdown" | "image" | "video" | "audio" | "pdf" | "binary";
  language: string | null;
  mimeType: string;
}

const EXT_MAP: Record<string, FileTypeInfo> = {
  ".ts": { type: "text", language: "typescript", mimeType: "text/plain" },
  ".tsx": { type: "text", language: "typescript", mimeType: "text/plain" },
  ".js": { type: "text", language: "javascript", mimeType: "text/plain" },
  ".jsx": { type: "text", language: "javascript", mimeType: "text/plain" },
  ".json": { type: "text", language: "json", mimeType: "text/plain" },
  ".css": { type: "text", language: "css", mimeType: "text/plain" },
  ".yaml": { type: "text", language: "yaml", mimeType: "text/plain" },
  ".yml": { type: "text", language: "yaml", mimeType: "text/plain" },
  ".html": { type: "text", language: "html", mimeType: "text/plain" },
  ".py": { type: "text", language: "python", mimeType: "text/plain" },
  ".sh": { type: "text", language: "shell", mimeType: "text/plain" },
  ".sql": { type: "text", language: "sql", mimeType: "text/plain" },
  ".env": { type: "text", language: "text", mimeType: "text/plain" },
  ".txt": { type: "text", language: "text", mimeType: "text/plain" },
  ".md": { type: "markdown", language: "markdown", mimeType: "text/plain" },
  ".mdx": { type: "markdown", language: "markdown", mimeType: "text/plain" },
  ".png": { type: "image", language: null, mimeType: "image/png" },
  ".jpg": { type: "image", language: null, mimeType: "image/jpeg" },
  ".jpeg": { type: "image", language: null, mimeType: "image/jpeg" },
  ".gif": { type: "image", language: null, mimeType: "image/gif" },
  ".svg": { type: "image", language: null, mimeType: "image/svg+xml" },
  ".webp": { type: "image", language: null, mimeType: "image/webp" },
  ".ico": { type: "image", language: null, mimeType: "image/x-icon" },
  ".mp4": { type: "video", language: null, mimeType: "video/mp4" },
  ".webm": { type: "video", language: null, mimeType: "video/webm" },
  ".mov": { type: "video", language: null, mimeType: "video/quicktime" },
  ".mp3": { type: "audio", language: null, mimeType: "audio/mpeg" },
  ".wav": { type: "audio", language: null, mimeType: "audio/wav" },
  ".ogg": { type: "audio", language: null, mimeType: "audio/ogg" },
  ".m4a": { type: "audio", language: null, mimeType: "audio/mp4" },
  ".pdf": { type: "pdf", language: null, mimeType: "application/pdf" },
};

function getFileTypeInfo(filePath: string): FileTypeInfo {
  const ext = path.extname(filePath).toLowerCase();
  return EXT_MAP[ext] ?? { type: "binary", language: null, mimeType: "application/octet-stream" };
}

const MAX_TEXT_SIZE = 500 * 1024; // 500KB
const MAX_STREAM_SIZES: Record<string, number> = {
  image: 20 * 1024 * 1024,
  video: 2 * 1024 * 1024 * 1024,
  audio: 100 * 1024 * 1024,
  pdf: 50 * 1024 * 1024,
};

function parseGitStatus(projectRoot: string): Map<string, string> {
  const statusMap = new Map<string, string>();
  try {
    const raw = execSync("git status --porcelain", {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: 5000,
    });
    for (const line of raw.split("\n")) {
      if (!line || line.length < 4) continue;
      const code = line.slice(0, 2).trim();
      const filePath = line.slice(3).trim();
      if (!filePath) continue;
      let status: string;
      if (code === "??" || code === "A" || code.includes("A")) status = "added";
      else if (code === "D" || code.includes("D")) status = "deleted";
      else if (code === "R" || code.includes("R")) status = "renamed";
      else if (code === "M" || code.includes("M")) status = "modified";
      else status = "untracked";
      statusMap.set(filePath, status);
    }
  } catch {
    // git not available or not a repo — return empty map
  }
  return statusMap;
}

function getGitBranch(projectRoot: string): string | null {
  try {
    return (
      execSync("git rev-parse --abbrev-ref HEAD", {
        cwd: projectRoot,
        encoding: "utf8",
        timeout: 3000,
      }).trim() || null
    );
  } catch {
    return null;
  }
}

function resolveProjectRoot(
  taskId: string,
  db: RuntimeContext["db"],
  taskWorktrees: RuntimeContext["taskWorktrees"],
): string | null {
  const wtInfo = taskWorktrees.get(taskId);
  if (wtInfo?.worktreePath) return wtInfo.worktreePath;
  const task = db.prepare("SELECT project_path FROM tasks WHERE id = ?").get(taskId) as
    | { project_path: string | null }
    | undefined;
  return task?.project_path || null;
}

function isPathSafe(root: string, requestedPath: string): string | null {
  const normalizedRoot = root.endsWith(path.sep) ? root : root + path.sep;
  const resolved = path.resolve(root, requestedPath);
  if (resolved !== root && !resolved.startsWith(normalizedRoot)) return null;
  try {
    const real = fs.realpathSync(resolved);
    const realRoot = fs.realpathSync(root);
    const normalizedRealRoot = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
    if (real !== realRoot && !real.startsWith(normalizedRealRoot)) return null;
    return real;
  } catch {
    return resolved === root || resolved.startsWith(normalizedRoot) ? resolved : null;
  }
}

function dirHasGitChanges(dirRelative: string, gitMap: Map<string, string>): boolean {
  const prefix = dirRelative.endsWith("/") ? dirRelative : `${dirRelative}/`;
  for (const key of gitMap.keys()) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}

export function registerTaskBrowseRoutes(ctx: RuntimeContext): void {
  const { app, db, taskWorktrees } = ctx;

  // Validate projectPath against known project paths in the DB (tasks + projects tables)
  function isKnownProjectPath(candidate: string): boolean {
    const normalized = candidate.endsWith(path.sep) ? candidate.slice(0, -1) : candidate;
    const row = db
      .prepare(
        `
      SELECT 1 AS found FROM tasks WHERE project_path = ? AND project_path IS NOT NULL
      UNION
      SELECT 1 AS found FROM projects WHERE project_path = ? AND project_path IS NOT NULL
      LIMIT 1
    `,
      )
      .get(normalized, normalized) as { found: number } | undefined;
    return Boolean(row);
  }

  // Directory listing / file metadata
  // Supports both task-based (/api/tasks/:taskId/browse) and direct path (/api/browse?projectPath=...)
  app.get("/api/browse", (req, res) => {
    const projectPath = String(req.query.projectPath ?? "");
    if (!projectPath || !path.isAbsolute(projectPath)) {
      return res.status(400).json({ ok: false, error: "invalid_project_path" });
    }
    if (!isKnownProjectPath(projectPath)) {
      return res.status(403).json({ ok: false, error: "path_not_allowed" });
    }
    try {
      if (!fs.statSync(projectPath).isDirectory()) {
        return res.status(400).json({ ok: false, error: "not_a_directory" });
      }
    } catch {
      return res.status(404).json({ ok: false, error: "no_project_path" });
    }
    return handleBrowse(req, res, projectPath, null);
  });

  app.get("/api/tasks/:taskId/browse", (req, res) => {
    const { taskId } = req.params;

    const projectRoot = resolveProjectRoot(taskId, db, taskWorktrees);
    if (!projectRoot) {
      return res.status(404).json({ ok: false, error: "no_project_path" });
    }
    return handleBrowse(req, res, projectRoot, taskId);
  });

  function handleBrowse(
    req: Parameters<Parameters<typeof app.get>[1]>[0],
    res: Parameters<Parameters<typeof app.get>[1]>[1],
    projectRoot: string,
    taskId: string | null,
  ): void {
    const relativePath = String(req.query.path ?? "/").replace(/^\/+/, "");
    const wantContent = req.query.content === "true";

    const fullPath = isPathSafe(projectRoot, relativePath);
    if (!fullPath) {
      res.status(400).json({ ok: false, error: "invalid_path" });
      return;
    }

    try {
      const stat = fs.statSync(fullPath);
      const gitMap = parseGitStatus(projectRoot);
      const branchName = getGitBranch(projectRoot);

      if (stat.isDirectory()) {
        const entries: DirEntry[] = [];
        const dirents = fs.readdirSync(fullPath, { withFileTypes: true });
        for (const dirent of dirents) {
          if (dirent.name.startsWith(".")) continue;
          const entryRelative = relativePath ? `${relativePath}/${dirent.name}` : dirent.name;
          const isDir = dirent.isDirectory();
          let size = 0;
          if (!isDir) {
            try {
              size = fs.statSync(path.join(fullPath, dirent.name)).size;
            } catch {
              /* ignore */
            }
          }
          const gitStatus = isDir
            ? dirHasGitChanges(entryRelative, gitMap)
              ? "has_changes"
              : null
            : (gitMap.get(entryRelative) ?? null);
          entries.push({ name: dirent.name, type: isDir ? "directory" : "file", size, gitStatus });
        }
        entries.sort((a, b) => {
          if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        res.json({ ok: true, basePath: projectRoot, branchName, relativePath: relativePath || "/", entries });
        return;
      }

      const typeInfo = getFileTypeInfo(fullPath);
      const fileRelative = relativePath;

      if (wantContent && (typeInfo.type === "text" || typeInfo.type === "markdown")) {
        if (stat.size > MAX_TEXT_SIZE) {
          res.json({
            ok: true,
            relativePath: fileRelative,
            type: typeInfo.type,
            language: typeInfo.language,
            mimeType: typeInfo.mimeType,
            size: stat.size,
            gitStatus: gitMap.get(fileRelative) ?? null,
            content: null,
            error: "file_too_large",
          });
          return;
        }
        const content = fs.readFileSync(fullPath, "utf8");
        res.json({
          ok: true,
          relativePath: fileRelative,
          type: typeInfo.type,
          language: typeInfo.language,
          mimeType: typeInfo.mimeType,
          size: stat.size,
          gitStatus: gitMap.get(fileRelative) ?? null,
          content,
        });
        return;
      }

      const maxStream = MAX_STREAM_SIZES[typeInfo.type] ?? MAX_TEXT_SIZE;
      const streamUrl =
        stat.size <= maxStream
          ? taskId
            ? `/api/tasks/${taskId}/browse/stream?path=${encodeURIComponent(fileRelative)}`
            : `/api/browse/stream?projectPath=${encodeURIComponent(projectRoot)}&path=${encodeURIComponent(fileRelative)}`
          : null;
      res.json({
        ok: true,
        relativePath: fileRelative,
        type: typeInfo.type,
        language: typeInfo.language,
        mimeType: typeInfo.mimeType,
        size: stat.size,
        gitStatus: gitMap.get(fileRelative) ?? null,
        streamUrl,
      });
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        res.status(404).json({ ok: false, error: "not_found" });
        return;
      }
      log.error({ err }, "browse error");
      res.status(500).json({ ok: false, error: "browse_failed" });
    }
  }

  // Stream endpoints for media files
  function handleStream(
    req: Parameters<Parameters<typeof app.get>[1]>[0],
    res: Parameters<Parameters<typeof app.get>[1]>[1],
    projectRoot: string,
  ): void {
    const relativePath = String(req.query.path ?? "");
    const fullPath = isPathSafe(projectRoot, relativePath);
    if (!fullPath) {
      res.status(400).json({ ok: false, error: "invalid_path" });
      return;
    }

    try {
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        res.status(400).json({ ok: false, error: "is_directory" });
        return;
      }

      const typeInfo = getFileTypeInfo(fullPath);
      const maxSize = MAX_STREAM_SIZES[typeInfo.type] ?? MAX_TEXT_SIZE;
      if (stat.size > maxSize) {
        res.status(413).json({ ok: false, error: "file_too_large" });
        return;
      }

      const range = req.headers.range;
      if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
        if (isNaN(start) || isNaN(end) || start < 0 || end >= stat.size || start > end) {
          res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
          res.end();
          return;
        }
        const chunkSize = end - start + 1;
        const stream = fs.createReadStream(fullPath, { start, end });
        res.writeHead(206, {
          "Content-Range": `bytes ${start}-${end}/${stat.size}`,
          "Accept-Ranges": "bytes",
          "Content-Length": chunkSize,
          "Content-Type": typeInfo.mimeType,
        });
        stream.pipe(res);
      } else {
        res.writeHead(200, {
          "Content-Length": stat.size,
          "Content-Type": typeInfo.mimeType,
          "Accept-Ranges": "bytes",
        });
        fs.createReadStream(fullPath).pipe(res);
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        res.status(404).json({ ok: false, error: "not_found" });
        return;
      }
      log.error({ err }, "stream error");
      res.status(500).json({ ok: false, error: "stream_failed" });
    }
  }

  app.get("/api/tasks/:taskId/browse/stream", (req, res) => {
    const projectRoot = resolveProjectRoot(req.params.taskId, db, taskWorktrees);
    if (!projectRoot) return res.status(404).json({ ok: false, error: "no_project_path" });
    handleStream(req, res, projectRoot);
  });

  app.get("/api/browse/stream", (req, res) => {
    const projectPath = String(req.query.projectPath ?? "");
    if (!projectPath || !path.isAbsolute(projectPath)) {
      return res.status(400).json({ ok: false, error: "invalid_project_path" });
    }
    if (!isKnownProjectPath(projectPath)) {
      return res.status(403).json({ ok: false, error: "path_not_allowed" });
    }
    handleStream(req, res, projectPath);
  });
}
