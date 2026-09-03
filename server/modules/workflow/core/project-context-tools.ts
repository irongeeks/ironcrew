import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createPromptSkillsHelper } from "./prompt-skills.ts";
import { logger } from "../../../observability/logger.ts";

const log = logger.child({ module: "core-workflow" });

type DbLike = {
  prepare: (sql: string) => {
    get: (...args: any[]) => unknown;
    all: (...args: any[]) => unknown;
  };
};

type CreateProjectContextToolsDeps = {
  db: DbLike;
  isGitRepo: (dir: string) => boolean;
  taskWorktrees: Map<string, { worktreePath: string; branchName: string; projectPath: string }>;
};

export function createProjectContextTools(deps: CreateProjectContextToolsDeps) {
  const { db, isGitRepo, taskWorktrees } = deps;

  const MVP_CODE_REVIEW_POLICY_BASE_LINES = [
    "[MVP Code Review Policy / 코드 리뷰 정책]",
    "- CRITICAL/HIGH: fix immediately / 즉시 수정",
    "- MEDIUM/LOW: warning report only, no code changes / 경고 보고서만, 코드 수정 금지",
  ];
  const EXECUTION_CONTINUITY_POLICY_LINES = [
    "[Execution Continuity / 실행 연속성]",
    "- Continue from the latest state without self-introduction or kickoff narration / 자기소개·착수 멘트 없이 최신 상태에서 바로 이어서 작업",
    "- Reuse prior codebase understanding and read only files needed for this delta / 기존 코드베이스 이해를 재사용하고 이번 변경에 필요한 파일만 확인",
    "- Focus on unresolved checklist items and produce concrete diffs first / 미해결 체크리스트 중심으로 즉시 코드 변경부터 진행",
    "[Git Workflow Guardrail / Git 워크플로우 가드레일]",
    "- Do NOT run git merge/rebase/cherry-pick/push during task execution. Merge is performed only by the system after final review approval / 작업 실행 중 git merge/rebase/cherry-pick/push 금지. 병합은 최종 리뷰 승인 후 시스템이 수행",
  ];

  const WARNING_FIX_OVERRIDE_LINE =
    "- Exception override: User explicitly requested warning-level fixes for this task. You may fix the requested MEDIUM/LOW items / 예외: 이 작업에서 사용자 요청 시 MEDIUM/LOW도 해당 요청 범위 내에서 수정 가능";

  function hasExplicitWarningFixRequest(...textParts: Array<string | null | undefined>): boolean {
    const text = textParts
      .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
      .join("\n");
    if (!text) return false;
    if (/\[(ALLOW_WARNING_FIX|WARN_FIX)\]/i.test(text)) return true;

    const requestHint =
      /\b(please|can you|need to|must|should|fix this|fix these|resolve this|address this|fix requested|warning fix)\b|해줘|해주세요|수정해|수정해야|고쳐|고쳐줘|해결해|반영해|조치해|수정 요청/i;
    if (!requestHint.test(text)) return false;

    const warningFixPair =
      /\b(fix|resolve|address|patch|remediate|correct)\b[\s\S]{0,60}\b(warning|warnings|medium|low|minor|non-critical|lint)\b|\b(warning|warnings|medium|low|minor|non-critical|lint)\b[\s\S]{0,60}\b(fix|resolve|address|patch|remediate|correct)\b|(?:경고|워닝|미디엄|로우|마이너|사소|비치명|린트)[\s\S]{0,40}(?:수정|고쳐|해결|반영|조치)|(?:수정|고쳐|해결|반영|조치)[\s\S]{0,40}(?:경고|워닝|미디엄|로우|마이너|사소|비치명|린트)/i;
    return warningFixPair.test(text);
  }

  function buildMvpCodeReviewPolicyBlock(allowWarningFix: boolean): string {
    const lines = [...MVP_CODE_REVIEW_POLICY_BASE_LINES];
    if (allowWarningFix) lines.push(WARNING_FIX_OVERRIDE_LINE);
    return lines.join("\n");
  }

  function buildTaskExecutionPrompt(
    parts: Array<string | null | undefined>,
    opts: { allowWarningFix?: boolean } = {},
  ): string {
    return [
      ...parts,
      EXECUTION_CONTINUITY_POLICY_LINES.join("\n"),
      buildMvpCodeReviewPolicyBlock(Boolean(opts.allowWarningFix)),
    ]
      .filter(Boolean)
      .join("\n");
  }

  const { buildAvailableSkillsPromptBlock } = createPromptSkillsHelper(db as any);

  const CONTEXT_IGNORE_DIRS = new Set([
    "node_modules",
    "dist",
    "build",
    ".next",
    ".nuxt",
    "out",
    "__pycache__",
    ".git",
    ".octooffice-worktrees",
    ".octooffice",
    "vendor",
    ".venv",
    "venv",
    "coverage",
    ".cache",
    ".turbo",
    ".parcel-cache",
    "target",
    "bin",
    "obj",
  ]);

  const CONTEXT_IGNORE_FILES = new Set([
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "bun.lockb",
    ".DS_Store",
    "Thumbs.db",
  ]);

  function buildFileTree(dir: string, prefix = "", depth = 0, maxDepth = 4): string[] {
    if (depth >= maxDepth) return [`${prefix}...`];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    entries = entries
      .filter((e) => !e.isSymbolicLink())
      .filter((e) => !e.name.startsWith(".") || e.name === ".env.example")
      .filter((e) => !CONTEXT_IGNORE_DIRS.has(e.name) && !CONTEXT_IGNORE_FILES.has(e.name))
      .sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });

    const lines: string[] = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const isLast = i === entries.length - 1;
      const connector = isLast ? "└── " : "├── ";
      const childPrefix = isLast ? "    " : "│   ";
      if (e.isDirectory()) {
        lines.push(`${prefix}${connector}${e.name}/`);
        lines.push(...buildFileTree(path.join(dir, e.name), prefix + childPrefix, depth + 1, maxDepth));
      } else {
        lines.push(`${prefix}${connector}${e.name}`);
      }
    }
    return lines;
  }

  function detectTechStack(projectPath: string): string[] {
    const stack: string[] = [];
    try {
      const pkgPath = path.join(projectPath, "package.json");
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
        const sv = (v: unknown) =>
          String(v ?? "")
            .replace(/[\n\r]/g, "")
            .slice(0, 20);
        if (allDeps.react) stack.push(`React ${sv(allDeps.react)}`);
        if (allDeps.next) stack.push(`Next.js ${sv(allDeps.next)}`);
        if (allDeps.vue) stack.push(`Vue ${sv(allDeps.vue)}`);
        if (allDeps.svelte) stack.push("Svelte");
        if (allDeps.express) stack.push("Express");
        if (allDeps.fastify) stack.push("Fastify");
        if (allDeps.typescript) stack.push("TypeScript");
        if (allDeps.tailwindcss) stack.push("Tailwind CSS");
        if (allDeps.vite) stack.push("Vite");
        if (allDeps.webpack) stack.push("Webpack");
        if (allDeps.prisma || allDeps["@prisma/client"]) stack.push("Prisma");
        if (allDeps.drizzle) stack.push("Drizzle");
        const runtime = pkg.engines?.node ? `Node.js ${sv(pkg.engines.node)}` : "Node.js";
        if (!stack.some((s) => s.startsWith("Node"))) stack.unshift(runtime);
      }
    } catch {
      /* ignore parse errors */
    }
    try {
      if (fs.existsSync(path.join(projectPath, "requirements.txt"))) stack.push("Python");
    } catch {
      // ignored
    }
    try {
      if (fs.existsSync(path.join(projectPath, "go.mod"))) stack.push("Go");
    } catch {
      // ignored
    }
    try {
      if (fs.existsSync(path.join(projectPath, "Cargo.toml"))) stack.push("Rust");
    } catch {
      // ignored
    }
    try {
      if (fs.existsSync(path.join(projectPath, "pom.xml"))) stack.push("Java (Maven)");
    } catch {
      // ignored
    }
    try {
      if (
        fs.existsSync(path.join(projectPath, "build.gradle")) ||
        fs.existsSync(path.join(projectPath, "build.gradle.kts"))
      )
        stack.push("Java (Gradle)");
    } catch {
      // ignored
    }
    return stack;
  }

  function getKeyFiles(projectPath: string): string[] {
    const keyPatterns = [
      "package.json",
      "tsconfig.json",
      "vite.config.ts",
      "vite.config.js",
      "next.config.js",
      "next.config.ts",
      "webpack.config.js",
      "Dockerfile",
      "docker-compose.yml",
      "docker-compose.yaml",
      ".env.example",
      "Makefile",
      "CMakeLists.txt",
    ];
    const result: string[] = [];

    for (const p of keyPatterns) {
      const fullPath = path.join(projectPath, p);
      try {
        if (fs.existsSync(fullPath)) {
          const stat = fs.statSync(fullPath);
          result.push(`${p} (${stat.size} bytes)`);
        }
      } catch {
        // ignored
      }
    }

    const srcDirs = ["src", "server", "app", "lib", "pages", "components", "api"];
    for (const d of srcDirs) {
      const dirPath = path.join(projectPath, d);
      try {
        if (fs.statSync(dirPath).isDirectory()) {
          let count = 0;
          const countFiles = (dir: string, depth = 0) => {
            if (depth > 10) return;
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const e of entries) {
              if (CONTEXT_IGNORE_DIRS.has(e.name) || e.isSymbolicLink()) continue;
              if (e.isDirectory()) countFiles(path.join(dir, e.name), depth + 1);
              else count++;
            }
          };
          countFiles(dirPath);
          result.push(`${d}/ (${count} files)`);
        }
      } catch {
        // ignored
      }
    }

    return result;
  }

  function buildProjectContextContent(projectPath: string): string {
    const sections: string[] = [];
    const projectName = path.basename(projectPath);

    sections.push(`# Project: ${projectName}\n`);

    const techStack = detectTechStack(projectPath);
    if (techStack.length) {
      sections.push(`## Tech Stack\n${techStack.join(", ")}\n`);
    }

    const tree = buildFileTree(projectPath);
    if (tree.length) {
      sections.push(`## File Structure\n\`\`\`\n${tree.join("\n")}\n\`\`\`\n`);
    }

    const keyFiles = getKeyFiles(projectPath);
    if (keyFiles.length) {
      sections.push(`## Key Files\n${keyFiles.map((f) => `- ${f}`).join("\n")}\n`);
    }

    for (const readmeName of ["README.md", "readme.md", "README.rst"]) {
      const readmePath = path.join(projectPath, readmeName);
      try {
        if (fs.existsSync(readmePath)) {
          const lines = fs.readFileSync(readmePath, "utf8").split("\n").slice(0, 20);
          sections.push(`## README (first 20 lines)\n${lines.join("\n")}\n`);
          break;
        }
      } catch {
        // ignored
      }
    }

    return sections.join("\n");
  }

  function generateProjectContext(projectPath: string): string {
    const octoofficeDir = path.join(projectPath, ".octooffice");
    const contextPath = path.join(octoofficeDir, "project-context.md");
    const metaPath = path.join(octoofficeDir, "project-context.meta");

    if (isGitRepo(projectPath)) {
      try {
        const currentHead = execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: projectPath,
          stdio: "pipe",
          timeout: 5000,
        })
          .toString()
          .trim();

        if (fs.existsSync(metaPath) && fs.existsSync(contextPath)) {
          const cachedHead = fs.readFileSync(metaPath, "utf8").trim();
          if (cachedHead === currentHead) {
            return fs.readFileSync(contextPath, "utf8");
          }
        }

        const content = buildProjectContextContent(projectPath);
        fs.mkdirSync(octoofficeDir, { recursive: true });
        fs.writeFileSync(contextPath, content, "utf8");
        fs.writeFileSync(metaPath, currentHead, "utf8");
        log.info({ contextPath }, "generated project context");
        return content;
      } catch (err) {
        log.warn({ err }, "failed to generate project context");
      }
    }

    try {
      if (fs.existsSync(contextPath)) {
        const stat = fs.statSync(contextPath);
        if (Date.now() - stat.mtimeMs < 5 * 60 * 1000) {
          return fs.readFileSync(contextPath, "utf8");
        }
      }
      const content = buildProjectContextContent(projectPath);
      fs.mkdirSync(octoofficeDir, { recursive: true });
      fs.writeFileSync(contextPath, content, "utf8");
      return content;
    } catch {
      return "";
    }
  }

  function getRecentChanges(projectPath: string, taskId: string): string {
    const parts: string[] = [];

    if (isGitRepo(projectPath)) {
      try {
        const log = execFileSync("git", ["log", "--oneline", "-10"], {
          cwd: projectPath,
          stdio: "pipe",
          timeout: 5000,
        })
          .toString()
          .trim();
        if (log) parts.push(`### Recent Commits\n${log}`);
      } catch {
        // ignored
      }

      try {
        const worktreeList = execFileSync("git", ["worktree", "list", "--porcelain"], {
          cwd: projectPath,
          stdio: "pipe",
          timeout: 5000,
        })
          .toString()
          .trim();

        const currentBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
          cwd: projectPath,
          stdio: "pipe",
          timeout: 5000,
        })
          .toString()
          .trim();

        const worktreeLines: string[] = [];
        const blocks = worktreeList.split("\n\n");
        for (const block of blocks) {
          const branchMatch = block.match(/branch refs\/heads\/(octooffice\/[^\s]+)/);
          if (!branchMatch) continue;
          const branch = branchMatch[1];
          try {
            const stat = execFileSync("git", ["diff", `${currentBranch}...${branch}`, "--stat", "--stat-width=60"], {
              cwd: projectPath,
              stdio: "pipe",
              timeout: 5000,
            })
              .toString()
              .trim();
            if (stat) worktreeLines.push(`  ${branch}:\n${stat}`);
          } catch {
            // ignored
          }
        }
        if (worktreeLines.length) {
          parts.push(`### Active Worktree Changes (other agents)\n${worktreeLines.join("\n")}`);
        }
      } catch {
        // ignored
      }
    }

    try {
      const recentTasks = db
        .prepare(
          `
      SELECT t.id, t.title, a.name AS agent_name, t.updated_at FROM tasks t
      LEFT JOIN agents a ON t.assigned_agent_id = a.id
      WHERE t.project_path = ? AND t.status = 'done' AND t.id != ?
      ORDER BY t.updated_at DESC LIMIT 3
    `,
        )
        .all(projectPath, taskId) as Array<{
        id: string;
        title: string;
        agent_name: string | null;
        updated_at: number;
      }>;

      if (recentTasks.length) {
        const taskLines = recentTasks.map((t) => `- ${t.title} (by ${t.agent_name || "unknown"})`);
        parts.push(`### Recently Completed Tasks\n${taskLines.join("\n")}`);
      }
    } catch {
      // ignored
    }

    if (!parts.length) return "";
    return parts.join("\n\n");
  }

  function ensureClaudeMd(projectPath: string, worktreePath: string): void {
    const projectClaudeMd = path.join(projectPath, "CLAUDE.md");

    // If project root has a CLAUDE.md, copy it directly to worktree
    if (fs.existsSync(projectClaudeMd)) {
      const dst = path.join(worktreePath, "CLAUDE.md");
      try {
        fs.copyFileSync(projectClaudeMd, dst);
      } catch (err) {
        log.warn({ err }, "failed to copy project CLAUDE.md to worktree");
      }
      return;
    }

    // No project CLAUDE.md — auto-generate with structured sections
    const octoofficeDir = path.join(projectPath, ".octooffice");
    const claudeMdSrc = path.join(octoofficeDir, "CLAUDE.md");
    const claudeMdDst = path.join(worktreePath, "CLAUDE.md");

    const AUTO_GEN_MARKER = "This file was auto-generated by OctoOffice to provide project context.";

    const shouldRefreshAutoGeneratedClaudeMd = (): boolean => {
      if (!fs.existsSync(claudeMdSrc)) return true;
      try {
        const existing = fs.readFileSync(claudeMdSrc, "utf8");
        if (!existing.includes(AUTO_GEN_MARKER)) return false;
        const hasProjectPath = /\*\*Project path:\*\*/.test(existing);
        const hasContextSection =
          /\*\*Stack:\*\*/.test(existing) ||
          /\*\*Key files:\*\*/.test(existing) ||
          /## Project Context Snapshot/.test(existing);
        return !(hasProjectPath && hasContextSection);
      } catch {
        return true;
      }
    };

    if (shouldRefreshAutoGeneratedClaudeMd()) {
      const techStack = detectTechStack(projectPath);
      const keyFiles = getKeyFiles(projectPath);
      const projectName = path.basename(projectPath);
      const contextSnapshotRaw = generateProjectContext(projectPath);
      const contextSnapshot = contextSnapshotRaw
        ? contextSnapshotRaw
            .split("\n")
            .filter((line) => line.trim().length > 0)
            .slice(0, 40)
            .join("\n")
        : "";

      const content = [
        `# ${projectName}`,
        "",
        "## Overview",
        `${projectName} project.`,
        "",
        "## Architecture",
        techStack.length ? `**Stack:** ${techStack.join(", ")}` : "**Stack:** (unable to detect)",
        "",
        keyFiles.length ? `**Key files:** ${keyFiles.slice(0, 12).join(", ")}` : "**Key files:** (unable to detect)",
        "",
        contextSnapshot ? contextSnapshot.slice(0, 3000) : "",
        "",
        "## Conventions",
        "",
        "## Decisions",
        "",
        "## Status",
        "Project initialized.",
        "",
        AUTO_GEN_MARKER,
      ]
        .filter((line) => line !== undefined)
        .join("\n");

      fs.mkdirSync(octoofficeDir, { recursive: true });
      fs.writeFileSync(claudeMdSrc, content, "utf8");
      log.info({ path: claudeMdSrc }, "generated CLAUDE.md");
    }

    try {
      fs.copyFileSync(claudeMdSrc, claudeMdDst);
    } catch (err) {
      log.warn({ err }, "failed to copy CLAUDE.md to worktree");
    }
  }

  return {
    hasExplicitWarningFixRequest,
    buildTaskExecutionPrompt,
    buildAvailableSkillsPromptBlock,
    generateProjectContext,
    getRecentChanges,
    ensureClaudeMd,
    CONTEXT_IGNORE_DIRS,
    CONTEXT_IGNORE_FILES,
    taskWorktrees,
  };
}
