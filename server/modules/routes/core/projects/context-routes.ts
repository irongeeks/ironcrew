import type { Express } from "express";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import {
  parseClaudeMd,
  writeClaudeMd,
  SECTION_CHAR_LIMITS,
  SECTION_KEYS,
  type ClaudeMdSections,
} from "../../../workflow/core/claude-md-parser.ts";
import { getFirstEnabledProvider, resolveModel, callLlm } from "../../../workflow/orchestration/llm-call.ts";
import { logger } from "../../../../observability/logger.ts";

interface RegisterProjectContextRoutesOptions {
  app: Express;
  db: DatabaseSync;
}

interface ProjectRow {
  id: string;
  name: string;
  project_path: string;
  core_goal: string | null;
}

/**
 * Static fallback when no LLM provider is available.
 */
function buildStaticSections(
  _projectPath: string,
  project: ProjectRow,
  fileTree: string[],
  keyFileContents: Record<string, string>,
): ClaudeMdSections {
  const techStack: string[] = [];
  const pkgContent = keyFileContents["package.json"];
  if (pkgContent) {
    try {
      const pkg = JSON.parse(pkgContent);
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      const sv = (v: unknown) =>
        String(v ?? "")
          .replace(/[\n\r]/g, "")
          .slice(0, 20);
      if (allDeps.react) techStack.push(`React ${sv(allDeps.react)}`);
      if (allDeps.next) techStack.push(`Next.js ${sv(allDeps.next)}`);
      if (allDeps.vue) techStack.push(`Vue ${sv(allDeps.vue)}`);
      if (allDeps.svelte) techStack.push("Svelte");
      if (allDeps.express) techStack.push("Express");
      if (allDeps.fastify) techStack.push("Fastify");
      if (allDeps.typescript) techStack.push("TypeScript");
      if (allDeps.tailwindcss) techStack.push("Tailwind CSS");
      if (allDeps.vite) techStack.push("Vite");
      const runtime = pkg.engines?.node ? `Node.js ${sv(pkg.engines.node)}` : "Node.js";
      if (!techStack.some((s) => s.startsWith("Node"))) techStack.unshift(runtime);
    } catch {
      /* ignore */
    }
  }
  if (keyFileContents["requirements.txt"] || keyFileContents["pyproject.toml"]) techStack.push("Python");
  if (keyFileContents["go.mod"] !== undefined) techStack.push("Go");
  if (keyFileContents["Cargo.toml"] !== undefined) techStack.push("Rust");

  const archParts: string[] = [];
  if (techStack.length) archParts.push(`**Tech stack:** ${techStack.join(", ")}`);
  const configFiles = Object.keys(keyFileContents).filter((f) => f !== "README.md" && f !== "readme.md");
  if (configFiles.length) archParts.push(`**Key files:** ${configFiles.join(", ")}`);

  const topDirs = [...new Set(fileTree.map((f) => f.split("/")[0]).filter((d) => !d.includes(".")))].slice(0, 15);
  if (topDirs.length) archParts.push(`**Top-level directories:** ${topDirs.join(", ")}`);

  const readme = keyFileContents["README.md"] ?? keyFileContents["readme.md"];
  if (readme) {
    archParts.push(`**From README:**\n${readme.split("\n").slice(0, 30).join("\n")}`);
  }

  return {
    overview: project.core_goal ?? project.name,
    architecture: archParts.join("\n\n") || "No architecture info detected.",
    conventions: "",
    decisions: "",
    status: `Project context initialized (static analysis — configure an API provider for LLM-powered analysis). ${fileTree.length} files detected.`,
  };
}

const log = logger.child({ module: "project-context" });

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  "target",
  "vendor",
  ".idea",
  ".vscode",
  "coverage",
  ".turbo",
  ".cache",
  ".parcel-cache",
  "out",
  ".svelte-kit",
]);

const IGNORE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".ico",
  ".webp",
  ".avif",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".otf",
  ".mp3",
  ".mp4",
  ".wav",
  ".ogg",
  ".webm",
  ".zip",
  ".tar",
  ".gz",
  ".bz2",
  ".7z",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".pyc",
  ".pyo",
  ".class",
  ".o",
  ".sqlite",
  ".db",
  ".lock",
]);

/**
 * Recursively collect file tree (paths only, respecting ignore rules).
 */
function collectFileTree(dir: string, base: string, maxFiles = 500): string[] {
  const result: string[] = [];

  function walk(current: string) {
    if (result.length >= maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (result.length >= maxFiles) break;
      if (entry.name.startsWith(".") && entry.isDirectory()) continue;
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        walk(path.join(current, entry.name));
      } else {
        const ext = path.extname(entry.name).toLowerCase();
        if (IGNORE_EXTENSIONS.has(ext)) continue;
        result.push(path.relative(base, path.join(current, entry.name)));
      }
    }
  }

  walk(dir);
  return result.sort();
}

/**
 * Read a file safely, returning null if it doesn't exist or is too large.
 */
function safeReadFile(filePath: string, maxBytes = 30_000): string | null {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > maxBytes) return `[file too large: ${stat.size} bytes]`;
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

/**
 * Collect key files content for LLM analysis.
 */
function collectKeyFileContents(projectPath: string): Record<string, string> {
  const candidates = [
    "package.json",
    "tsconfig.json",
    "pyproject.toml",
    "setup.py",
    "setup.cfg",
    "requirements.txt",
    "Pipfile",
    "go.mod",
    "Cargo.toml",
    "Gemfile",
    "Makefile",
    "Dockerfile",
    "docker-compose.yml",
    "docker-compose.yaml",
    "compose.yaml",
    ".env.example",
    "README.md",
    "readme.md",
    "README.rst",
    "vite.config.ts",
    "vite.config.js",
    "next.config.js",
    "next.config.ts",
    "next.config.mjs",
    "webpack.config.js",
    "rollup.config.js",
    "tailwind.config.js",
    "tailwind.config.ts",
    "eslint.config.js",
    ".eslintrc.json",
    ".eslintrc.js",
    "CLAUDE.md",
    "AGENTS.md",
    "CONTRIBUTING.md",
  ];
  const contents: Record<string, string> = {};
  for (const name of candidates) {
    const content = safeReadFile(path.join(projectPath, name));
    if (content !== null) contents[name] = content;
  }
  return contents;
}

const INIT_SYSTEM_PROMPT = `You are a senior software engineer analyzing a code repository to generate a CLAUDE.md project context file.

Your output MUST be valid JSON with exactly these keys:
{
  "overview": "1-3 sentence project description — what it does, who it's for",
  "architecture": "Tech stack, key directories, how the pieces fit together. Use markdown.",
  "conventions": "Naming conventions, formatting rules, patterns used in the codebase. Use markdown.",
  "decisions": "Notable architectural decisions or trade-offs visible in the code",
  "status": "Current state of the project based on what you can see"
}

Guidelines:
- Be specific and concrete — reference actual files, directories, and technologies you see
- For architecture, describe the actual structure, not generic advice
- For conventions, infer from the code (naming patterns, formatting, test patterns)
- Keep each section concise but informative (200-800 chars each)
- Output ONLY the JSON object, no markdown fences, no explanation`;

export function registerProjectContextRoutes({ app, db }: RegisterProjectContextRoutesOptions): void {
  // ---------- GET /api/projects/:id/context ----------
  app.get("/api/projects/:id/context", (req, res) => {
    const id = String(req.params.id);
    const project = db.prepare("SELECT id, name, project_path, core_goal FROM projects WHERE id = ?").get(id) as
      | ProjectRow
      | undefined;
    if (!project) return res.status(404).json({ ok: false, error: "not_found" });

    const claudeMdPath = path.join(project.project_path, "CLAUDE.md");
    let raw = "";
    let exists = false;

    try {
      raw = fs.readFileSync(claudeMdPath, "utf8");
      exists = true;
    } catch {
      // CLAUDE.md does not exist
    }

    if (exists) {
      const parsed = parseClaudeMd(raw);
      const charCounts: Record<string, number> = {};
      for (const key of SECTION_KEYS) {
        charCounts[key] = parsed.sections[key].length;
      }
      return res.json({
        raw: parsed.raw,
        sections: parsed.sections,
        charLimits: SECTION_CHAR_LIMITS,
        charCounts,
        exists: true,
      });
    }

    // No CLAUDE.md — return empty sections with core_goal fallback
    const emptySections: ClaudeMdSections = {
      overview: project.core_goal ?? "",
      architecture: "",
      conventions: "",
      decisions: "",
      status: "",
    };
    const charCounts: Record<string, number> = {};
    for (const key of SECTION_KEYS) {
      charCounts[key] = emptySections[key].length;
    }
    return res.json({
      raw: "",
      sections: emptySections,
      charLimits: SECTION_CHAR_LIMITS,
      charCounts,
      exists: false,
    });
  });

  // ---------- PUT /api/projects/:id/context ----------
  app.put("/api/projects/:id/context", (req, res) => {
    const id = String(req.params.id);
    const project = db.prepare("SELECT id, name, project_path, core_goal FROM projects WHERE id = ?").get(id) as
      | ProjectRow
      | undefined;
    if (!project) return res.status(404).json({ ok: false, error: "not_found" });

    const body = (req.body ?? {}) as { title?: string; sections?: ClaudeMdSections };
    if (!body.sections) return res.status(400).json({ ok: false, error: "sections_required" });

    const title = typeof body.title === "string" ? body.title.trim() : project.name;
    const assembled = writeClaudeMd(title, body.sections);

    try {
      fs.writeFileSync(path.join(project.project_path, "CLAUDE.md"), assembled, "utf8");
    } catch (err) {
      log.error({ err, projectId: id }, "write_failed");
      return res.status(500).json({ ok: false, error: "write_failed" });
    }

    // Backward compat: update core_goal from overview
    const overviewSlice = (body.sections.overview ?? "").slice(0, 1000);
    if (overviewSlice) {
      db.prepare("UPDATE projects SET core_goal = ? WHERE id = ?").run(
        overviewSlice as SQLInputValue,
        id as SQLInputValue,
      );
    }

    return res.json({ ok: true });
  });

  // ---------- POST /api/projects/:id/init-context ----------
  // Body: { use_llm?: boolean } — default false. When true AND an API provider
  // is configured, repository context (file tree + contents of CLAUDE.md,
  // AGENTS.md, package.json, README, …) is sent to that provider for analysis.
  // Without the flag, a purely local static analysis is used. The flag is an
  // explicit opt-in so a casual click in the UI cannot leak private repo
  // content to an external service.
  app.post("/api/projects/:id/init-context", async (req, res) => {
    const id = String(req.params.id);
    const project = db.prepare("SELECT id, name, project_path, core_goal FROM projects WHERE id = ?").get(id) as
      | ProjectRow
      | undefined;
    if (!project) return res.status(404).json({ ok: false, error: "not_found" });

    const body = (req.body ?? {}) as { use_llm?: unknown };
    const useLlm = body.use_llm === true;

    const projectPath = project.project_path;

    // Collect repo data for analysis
    const fileTree = collectFileTree(projectPath, projectPath);
    const keyFileContents = collectKeyFileContents(projectPath);

    let sections: ClaudeMdSections;
    const provider = useLlm ? getFirstEnabledProvider(db) : null;

    if (useLlm && provider) {
      // Build user message with repo context (only when user explicitly opted in)
      const userParts: string[] = [];
      userParts.push(`Project name: ${project.name}`);
      if (project.core_goal) userParts.push(`Description: ${project.core_goal}`);
      userParts.push(`\nFile tree (${fileTree.length} files):\n${fileTree.join("\n")}`);
      for (const [name, content] of Object.entries(keyFileContents)) {
        userParts.push(`\n--- ${name} ---\n${content}`);
      }
      const userMessage = userParts.join("\n").slice(0, 80_000);

      const settingRow = db.prepare("SELECT value FROM settings WHERE key = 'ceo_model'").get() as
        | { value: string }
        | undefined;
      const model = resolveModel(provider, settingRow?.value ?? "");

      try {
        const raw = await callLlm(provider, model, INIT_SYSTEM_PROMPT, userMessage);
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("No JSON object in LLM response");
        const parsed = JSON.parse(jsonMatch[0]) as Record<string, string>;
        sections = {
          overview: String(parsed.overview ?? project.core_goal ?? project.name),
          architecture: String(parsed.architecture ?? ""),
          conventions: String(parsed.conventions ?? ""),
          decisions: String(parsed.decisions ?? ""),
          status: String(parsed.status ?? ""),
        };
        log.info({ project: project.name, model, provider }, "init-context: LLM analysis complete");
      } catch (err) {
        log.warn({ err, project: project.name }, "init-context: LLM call failed, using static fallback");
        sections = buildStaticSections(projectPath, project, fileTree, keyFileContents);
      }
    } else {
      if (useLlm) {
        log.info({ project: project.name }, "init-context: LLM requested but no provider — static fallback");
      } else {
        log.info({ project: project.name }, "init-context: local static analysis (LLM opt-out)");
      }
      sections = buildStaticSections(projectPath, project, fileTree, keyFileContents);
    }

    const title = project.name;
    const raw = writeClaudeMd(title, sections);

    try {
      fs.writeFileSync(path.join(projectPath, "CLAUDE.md"), raw, "utf8");
    } catch (err) {
      log.error({ err }, "init-context: write failed");
      return res.status(500).json({ ok: false, error: "write_failed" });
    }

    return res.json({ sections, raw, used_llm: useLlm && provider !== null });
  });

  // ---------- GET /api/projects/:id/file-content ----------
  app.get("/api/projects/:id/file-content", (req, res) => {
    const id = String(req.params.id);
    const project = db.prepare("SELECT id, name, project_path FROM projects WHERE id = ?").get(id) as
      | Pick<ProjectRow, "id" | "name" | "project_path">
      | undefined;
    if (!project) return res.status(404).json({ ok: false, error: "not_found" });

    const relativePath = typeof req.query.path === "string" ? req.query.path : "";
    if (!relativePath) return res.status(400).json({ ok: false, error: "path_required" });

    // Resolve and guard against traversal
    const resolved = path.resolve(project.project_path, relativePath);
    if (!resolved.startsWith(project.project_path + path.sep) && resolved !== project.project_path) {
      return res.status(403).json({ ok: false, error: "path_traversal" });
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      return res.status(404).json({ ok: false, error: "file_not_found" });
    }

    const MAX_SIZE = 500 * 1024; // 500KB
    if (stat.size > MAX_SIZE) {
      return res.status(413).json({ ok: false, error: "file_too_large", size: stat.size, max: MAX_SIZE });
    }

    try {
      const content = fs.readFileSync(resolved, "utf8");
      return res.json({ content, path: relativePath, size: stat.size });
    } catch (err) {
      log.error({ err }, "read_failed");
      return res.status(500).json({ ok: false, error: "read_failed" });
    }
  });
}
