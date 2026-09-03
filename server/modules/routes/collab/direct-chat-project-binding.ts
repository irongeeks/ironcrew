import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Lang } from "../../../types/lang.ts";
import type { DelegationOptions } from "./project-resolution.ts";
import { detectProjectKindChoice } from "./direct-chat-intent-utils.ts";
import type { AgentRow, DirectChatDeps, ExistingProjectCandidate } from "./direct-chat-types.ts";
import { logger } from "../../../observability/logger.ts";

const log = logger.child({ module: "collab" });

function getNextProductionFolderId(productionPath: string): number {
  let maxId = 0;
  try {
    const entries = fs.readdirSync(productionPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const num = parseInt(entry.name, 10);
        if (!Number.isNaN(num) && num > maxId) {
          maxId = num;
        }
      }
    }
  } catch {
    // If PRODUCTION doesn't exist, start from 0
  }
  return maxId + 1;
}

function resolveProductionBasePath(): string | null {
  const candidates = [path.resolve(process.cwd(), "PRODUCTION")];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch {
      // Continue to next candidate
    }
  }
  return null;
}

export const RECENT_EXISTING_PROJECT_LIMIT = 10;

type ProjectBindingDeps = Pick<
  DirectChatDeps,
  "db" | "detectProjectPath" | "normalizeTextField" | "resolveProjectFromOptions" | "runAgentOneShot"
>;

type ProjectNameCandidateRow = {
  id: string;
  project_path: string | null;
  core_goal: string | null;
};

type ExistingProjectRow = {
  id: string;
  name: string | null;
  project_path: string | null;
  core_goal: string | null;
};

type ExistingProjectPathRow = {
  id: string;
  name: string | null;
  core_goal: string | null;
};

function expandUserPath(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/")) return path.join(os.homedir(), trimmed.slice(2));
  return trimmed;
}

function normalizeProjectPathForPolicy(value: string): string {
  const resolved = path.resolve(path.normalize(expandUserPath(value)));
  if (process.platform === "win32" || process.platform === "darwin") {
    return resolved.toLowerCase();
  }
  return resolved;
}

function parseAllowedProjectRootsFromEnv(): string[] {
  const raw = (process.env.PROJECT_PATH_ALLOWED_ROOTS || "").trim();
  const defaults = [path.join(os.homedir(), "Projects"), path.join(os.homedir(), "projects"), process.cwd()];
  const candidates = raw
    ? raw
        .split(/[\n,;]+/)
        .map((item) => item.trim())
        .filter(Boolean)
    : defaults;

  const normalized = candidates.map((candidate) => normalizeProjectPathForPolicy(candidate)).filter(Boolean);
  return [...new Set(normalized)];
}

function isPathUnderRoot(candidatePath: string, rootPath: string): boolean {
  const candidate = normalizeProjectPathForPolicy(candidatePath);
  const root = normalizeProjectPathForPolicy(rootPath);
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function isAllowedProjectCreationPath(projectPath: string): boolean {
  const allowedRoots = parseAllowedProjectRootsFromEnv();
  if (allowedRoots.length === 0) return false;
  return allowedRoots.some((root) => isPathUnderRoot(projectPath, root));
}

function extractAbsolutePathFromText(text: string): string | null {
  const candidates: string[] = [];
  for (const match of text.matchAll(/["'](~?\/[^"']+)["']/g)) {
    if (match[1]) candidates.push(match[1]);
  }
  for (const match of text.matchAll(/(?:^|\s)(~?\/[^\s"'`,;]+)/g)) {
    if (match[1]) candidates.push(match[1]);
  }

  for (const rawCandidate of candidates) {
    const cleaned = rawCandidate.replace(/[),.!?]+$/g, "").trim();
    if (!cleaned) continue;
    const expanded = expandUserPath(cleaned);
    if (!path.isAbsolute(expanded)) continue;
    return path.normalize(expanded);
  }
  return null;
}

export function normalizeNewProjectNameInput(text: string): string | null {
  let value = text.trim();
  if (!value) return null;

  value = value
    .replace(/^(프로젝트\s*)?(이름|명)\s*[:-]?\s*/i, "")
    .replace(/^(project\s*)?name\s*[:-]?\s*/i, "")
    .replace(/^(name)\s*[:-]?\s*/i, "")
    .trim();

  for (const match of value.matchAll(/(~?\/[^\s"'`,;]+)/g)) {
    if (match[1]) {
      value = value.replace(match[1], " ");
    }
  }

  value = value.replace(/["']/g, "").replace(/\s+/g, " ").trim();
  if (!value) return null;
  if (/^(신규|new|새(로운)?\s*프로젝트|project|프로젝트)$/i.test(value)) return null;
  return value.slice(0, 80);
}

function parseProjectKindFromModelOutput(text: string): "existing" | "new" | null {
  const normalized = text.trim();
  if (!normalized) return null;
  const upper = normalized.toUpperCase();
  if (/\bEXISTING\b/.test(upper)) return "existing";
  if (/\bNEW\b/.test(upper)) return "new";

  if (/(기존|既存|已有)/.test(normalized)) return "existing";
  if (/(신규|새 프로젝트|새로|新規|新项目|新しい)/.test(normalized)) return "new";
  return detectProjectKindChoice(normalized);
}

export async function inferProjectKindWithModel(
  deps: Pick<ProjectBindingDeps, "runAgentOneShot">,
  agent: AgentRow,
  lang: Lang,
  userReply: string,
): Promise<"existing" | "new" | null> {
  const localeInstruction =
    lang === "en"
      ? "Respond in English."
      : lang === "ja"
        ? "Respond in Japanese."
        : lang === "zh"
          ? "Respond in Chinese."
          : "Respond in Korean.";

  const prompt = [
    "[Project Kind Classifier]",
    localeInstruction,
    "Classify the user's intent into one label:",
    "- EXISTING: user means existing project",
    "- NEW: user means new project",
    "- UNKNOWN: unclear",
    "Return EXACTLY one token only: EXISTING or NEW or UNKNOWN",
    `User reply: ${JSON.stringify(userReply)}`,
  ].join("\n");

  try {
    const run = await deps.runAgentOneShot(agent, prompt, {
      projectPath: process.cwd(),
      rawOutput: true,
      noTools: true,
    });
    return parseProjectKindFromModelOutput(run.text || "");
  } catch (err) {
    log.warn({ err, agent: agent.name }, "project-kind model inference failed");
    return null;
  }
}

function normalizeLooseProjectName(value: string): string {
  return value
    .trim()
    .replace(/^[`"'“”‘’]+|[`"'“”‘’]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function loadRecentExistingProjects(
  deps: Pick<ProjectBindingDeps, "db" | "normalizeTextField">,
  limit: number = 5,
): ExistingProjectCandidate[] {
  const rows = deps.db
    .prepare(
      `
        SELECT p.id, p.name, p.project_path, p.core_goal
        FROM projects p
        ORDER BY COALESCE(p.last_used_at, p.updated_at) DESC, p.updated_at DESC, p.created_at DESC
        LIMIT ?
      `,
    )
    .all(limit) as ExistingProjectRow[];

  return rows.map((row) => ({
    id: row.id,
    name: deps.normalizeTextField(row.name),
    projectPath: deps.normalizeTextField(row.project_path),
    projectContext: deps.normalizeTextField(row.core_goal),
  }));
}

function latestProjectMarker(lang: Lang): string {
  if (lang === "en") return " [LATEST]";
  if (lang === "ja") return " [最新]";
  if (lang === "zh") return " [最新]";
  return " [최신]";
}

function projectPathLabel(lang: Lang): string {
  if (lang === "en") return "Path";
  if (lang === "ja") return "パス";
  if (lang === "zh") return "路径";
  return "경로";
}

function projectNameLabel(lang: Lang): string {
  if (lang === "en") return "Name";
  if (lang === "ja") return "名前";
  if (lang === "zh") return "名称";
  return "이름";
}

function resolveExistingProjectDisplayName(
  normalizeTextField: DirectChatDeps["normalizeTextField"],
  candidate: ExistingProjectCandidate,
): string {
  const explicitName = normalizeTextField(candidate.name);
  if (explicitName) return explicitName;

  const pathText = normalizeTextField(candidate.projectPath);
  if (pathText) {
    const normalized = path.normalize(pathText).replace(/[\\/]+$/g, "");
    const base = path.basename(normalized);
    if (base && base !== "." && base !== path.sep) return base;
  }

  return candidate.id;
}

function existingProjectNameMatchKeys(
  normalizeTextField: DirectChatDeps["normalizeTextField"],
  candidate: ExistingProjectCandidate,
): string[] {
  const values = new Set<string>();
  const explicitName = normalizeTextField(candidate.name);
  if (explicitName) values.add(explicitName.toLowerCase());
  values.add(resolveExistingProjectDisplayName(normalizeTextField, candidate).toLowerCase());
  return [...values];
}

export function formatExistingProjectCandidateLines(
  normalizeTextField: DirectChatDeps["normalizeTextField"],
  candidates: ExistingProjectCandidate[],
  lang: Lang,
): string[] {
  const marker = latestProjectMarker(lang);
  const nameLabel = projectNameLabel(lang);
  const pathLabel = projectPathLabel(lang);
  return candidates.map((candidate, index) => {
    const displayName = resolveExistingProjectDisplayName(normalizeTextField, candidate);
    const pathText = normalizeTextField(candidate.projectPath);
    const latestSuffix = index === 0 ? marker : "";
    if (!pathText) return `${index + 1}. ${nameLabel}: ${displayName}${latestSuffix}`;
    return `${index + 1}. ${nameLabel}: ${displayName}${latestSuffix}\n   ${pathLabel}: ${pathText}`;
  });
}

function extractNumberSelection(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const normalized = trimmed.toLowerCase().replace(/\s+/g, " ").trim();
  const compact = normalized.replace(/[^\p{L}\p{N}]+/gu, "");
  if (/1️⃣/.test(trimmed) || compact === "1") return 1;
  if (/2️⃣/.test(trimmed) || compact === "2") return 2;
  if (/3️⃣/.test(trimmed) || compact === "3") return 3;
  if (/4️⃣/.test(trimmed) || compact === "4") return 4;
  if (/5️⃣/.test(trimmed) || compact === "5") return 5;
  const numeric = normalized.match(/(?:^|\s)([1-9])(?:번|번째)?(?:으로|로)?(?:\s|$)/);
  if (!numeric?.[1]) return null;
  const value = Number.parseInt(numeric[1], 10);
  return Number.isFinite(value) ? value : null;
}

function buildProjectBindingFromCandidate(candidate: ExistingProjectCandidate): {
  projectId: string;
  projectPath: string | null;
  projectContext: string | null;
} {
  return {
    projectId: candidate.id,
    projectPath: candidate.projectPath,
    projectContext: candidate.projectContext,
  };
}

export function selectExistingProjectFromCandidates(
  deps: Pick<ProjectBindingDeps, "detectProjectPath" | "normalizeTextField">,
  text: string,
  candidates: ExistingProjectCandidate[],
): { projectId: string; projectPath: string | null; projectContext: string | null } | null {
  if (candidates.length === 0) return null;

  const index = extractNumberSelection(text);
  if (index && index >= 1 && index <= candidates.length) {
    return buildProjectBindingFromCandidate(candidates[index - 1]);
  }

  const detectedPath = deps.detectProjectPath(text) || extractAbsolutePathFromText(text);
  if (detectedPath) {
    const normalizedDetected = path.normalize(detectedPath);
    const byPath = candidates.find((candidate) => {
      const candidatePath = deps.normalizeTextField(candidate.projectPath);
      return candidatePath ? path.normalize(candidatePath) === normalizedDetected : false;
    });
    if (byPath) return buildProjectBindingFromCandidate(byPath);
  }

  const normalizedInput = normalizeLooseProjectName(text).toLowerCase();
  if (!normalizedInput) return null;
  const byExactName = candidates.find((candidate) => {
    const keys = existingProjectNameMatchKeys(deps.normalizeTextField, candidate);
    return keys.some((key) => key === normalizedInput);
  });
  if (byExactName) return buildProjectBindingFromCandidate(byExactName);

  const byContainsName = candidates.filter((candidate) => {
    const keys = existingProjectNameMatchKeys(deps.normalizeTextField, candidate);
    return keys.some((key) => key.includes(normalizedInput) || normalizedInput.includes(key));
  });
  if (byContainsName.length === 1) {
    return buildProjectBindingFromCandidate(byContainsName[0]);
  }

  return null;
}

function extractProjectNameCandidates(text: string): string[] {
  const values: string[] = [];
  const seen = new Set<string>();
  const add = (rawValue: string | null | undefined): void => {
    if (!rawValue) return;
    const cleaned = normalizeLooseProjectName(rawValue);
    if (!cleaned || cleaned.length < 2 || cleaned.length > 80) return;
    if (/^(기존|신규|새|project|프로젝트|name)$/i.test(cleaned)) return;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    values.push(cleaned);
  };

  for (const match of text.matchAll(
    /(?:프로젝트\s*(?:이름|명)?|project\s*name|name)\s*[:=]?\s*["'`]?([A-Za-z0-9][A-Za-z0-9._-]{1,79})["'`]?/gi,
  )) {
    add(match[1]);
  }

  for (const match of text.matchAll(/["'`]{1}([^"'`\n]{2,80})["'`]{1}/g)) {
    add(match[1]);
  }

  const compact = normalizeLooseProjectName(text);
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{1,79}$/.test(compact)) {
    add(compact);
  }

  return values;
}

function findProjectByNameCandidate(
  deps: Pick<ProjectBindingDeps, "db">,
  nameCandidate: string,
): ProjectNameCandidateRow | null {
  const exact = deps.db
    .prepare(
      `
        SELECT id, project_path, core_goal
        FROM projects
        WHERE LOWER(name) = LOWER(?)
        ORDER BY last_used_at DESC, updated_at DESC
        LIMIT 1
      `,
    )
    .get(nameCandidate) as ProjectNameCandidateRow | undefined;
  if (exact) return exact;

  const normalizedCandidate = normalizeLooseProjectName(nameCandidate);
  if (normalizedCandidate.length < 2) return null;
  const fuzzyRows = deps.db
    .prepare(
      `
        SELECT id, project_path, core_goal
        FROM projects
        WHERE LOWER(name) LIKE LOWER(?)
        ORDER BY last_used_at DESC, updated_at DESC
        LIMIT 3
      `,
    )
    .all(`%${normalizedCandidate}%`) as ProjectNameCandidateRow[];
  if (fuzzyRows.length !== 1) return null;
  return fuzzyRows[0];
}

export function hasProjectBinding(
  deps: Pick<ProjectBindingDeps, "normalizeTextField" | "resolveProjectFromOptions">,
  taskMessage: string,
  options: DelegationOptions,
): boolean {
  void taskMessage;
  if (deps.normalizeTextField(options.projectId)) return true;
  if (deps.normalizeTextField(options.projectPath)) return true;
  const selectedProject = deps.resolveProjectFromOptions(options);
  if (selectedProject.id || deps.normalizeTextField(selectedProject.projectPath)) return true;
  return false;
}

export function resolveProjectBindingFromText(
  deps: Pick<ProjectBindingDeps, "db" | "detectProjectPath" | "normalizeTextField">,
  text: string,
): {
  projectId?: string | null;
  projectPath?: string | null;
  projectContext?: string | null;
} | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const detectedPath = deps.detectProjectPath(trimmed);
  if (detectedPath) {
    const byPath = deps.db
      .prepare(
        `
          SELECT id, project_path, core_goal
          FROM projects
          WHERE project_path = ?
          ORDER BY last_used_at DESC, updated_at DESC
          LIMIT 1
        `,
      )
      .get(detectedPath) as ProjectNameCandidateRow | undefined;
    return {
      projectId: byPath?.id ?? null,
      projectPath: deps.normalizeTextField(byPath?.project_path) || detectedPath,
      projectContext: deps.normalizeTextField(byPath?.core_goal),
    };
  }

  const candidates = extractProjectNameCandidates(trimmed);
  for (const candidate of candidates) {
    const project = findProjectByNameCandidate(deps, candidate);
    if (!project) continue;
    return {
      projectId: project.id,
      projectPath: deps.normalizeTextField(project.project_path),
      projectContext: deps.normalizeTextField(project.core_goal),
    };
  }

  return null;
}

function findProjectByPath(deps: Pick<ProjectBindingDeps, "db">, projectPath: string): ExistingProjectPathRow | null {
  if (process.platform === "win32" || process.platform === "darwin") {
    return (
      (deps.db
        .prepare("SELECT id, name, core_goal FROM projects WHERE LOWER(project_path) = LOWER(?) LIMIT 1")
        .get(projectPath) as ExistingProjectPathRow | undefined) ?? null
    );
  }
  return (
    (deps.db.prepare("SELECT id, name, core_goal FROM projects WHERE project_path = ? LIMIT 1").get(projectPath) as
      | ExistingProjectPathRow
      | undefined) ?? null
  );
}

export function createProjectBindingFromNameAndPath(
  deps: Pick<ProjectBindingDeps, "db" | "normalizeTextField"> & { nowMs: () => number },
  taskMessage: string,
  nameInput: string,
  projectPathInput?: string,
): {
  projectId: string;
  projectPath: string;
  projectContext: string;
  projectName: string;
  existed: boolean;
} | null {
  // If no path provided, auto-create in PRODUCTION/
  let normalizedPath: string;

  if (projectPathInput) {
    normalizedPath = path.normalize(expandUserPath(projectPathInput));
    if (!path.isAbsolute(normalizedPath)) return null;
    if (!isAllowedProjectCreationPath(normalizedPath)) return null;
  } else {
    const productionBase = resolveProductionBasePath();
    if (!productionBase) return null;
    const nextId = getNextProductionFolderId(productionBase);
    normalizedPath = path.join(productionBase, String(nextId));
  }

  const existing = findProjectByPath(deps, normalizedPath);
  if (existing) {
    return {
      projectId: existing.id,
      projectPath: normalizedPath,
      projectContext: deps.normalizeTextField(existing.core_goal) || taskMessage.trim() || nameInput,
      projectName: deps.normalizeTextField(existing.name) || nameInput || path.basename(normalizedPath),
      existed: true,
    };
  }

  try {
    fs.mkdirSync(normalizedPath, { recursive: true });
    if (!fs.statSync(normalizedPath).isDirectory()) return null;
  } catch {
    return null;
  }

  const projectId = randomUUID();
  const t = deps.nowMs();
  const projectName = nameInput.trim() || path.basename(normalizedPath);
  const coreGoal = taskMessage.trim() || projectName;
  try {
    deps.db
      .prepare(
        `
        INSERT INTO projects (id, name, project_path, core_goal, assignment_mode, last_used_at, created_at, updated_at, github_repo)
        VALUES (?, ?, ?, ?, 'auto', ?, ?, ?, NULL)
      `,
      )
      .run(projectId, projectName, normalizedPath, coreGoal, t, t, t);
  } catch (err) {
    log.warn({ err }, "failed to insert project");
    return null;
  }

  return {
    projectId,
    projectPath: normalizedPath,
    projectContext: coreGoal,
    projectName,
    existed: false,
  };
}
