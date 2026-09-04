import fs from "node:fs";
import path from "node:path";
import { DOCS_SKILLS_PROFILE, createConnector, resolveTaskDocsProviders } from "./provider-service.ts";
import { titleFromPath } from "./wikilinks.ts";
import type { DocsProviderView, TaskDocsContextBundle } from "./types.ts";
import { PROJECT_STATE_DIR_NAME } from "../../workflow/core/worktree/shared.ts";

type DbLike = {
  prepare: (sql: string) => {
    all: (...args: any[]) => unknown;
    get: (...args: any[]) => unknown;
    run: (...args: any[]) => unknown;
  };
};

type TaskLike = {
  id?: string;
  title?: string;
  project_id?: string | null;
  project_path?: string | null;
};

type CopySummary = {
  copied: number;
  skipped: number;
};

const MAX_SNAPSHOT_FILES = 1500;
const MAX_CONTEXT_NOTE_LINES = 40;
const PINNED_NOTE_NAMES = ["CLAUDE.md", "Project Overview.md", "AGENTS.md", "README.md"];
const MAX_PINNED_CONTENT_CHARS = 4000;

function readPinnedNote(snapshotRoot: string): { relPath: string; content: string } | null {
  for (const name of PINNED_NOTE_NAMES) {
    const abs = path.join(snapshotRoot, name);
    if (!fs.existsSync(abs)) continue;
    try {
      const raw = fs.readFileSync(abs, "utf8").replace(/^\uFEFF/, "");
      return { relPath: name, content: raw.slice(0, MAX_PINNED_CONTENT_CHARS) };
    } catch {
      continue;
    }
  }
  return null;
}

function collectMarkdownFiles(root: string, dir: string, out: string[]): void {
  if (out.length >= MAX_SNAPSHOT_FILES) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (out.length >= MAX_SNAPSHOT_FILES) return;
    if (entry.name === ".obsidian") continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectMarkdownFiles(root, abs, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.toLowerCase().endsWith(".md")) continue;
    out.push(path.relative(root, abs).replace(/\\/g, "/"));
  }
}

function copyMarkdownTree(srcRoot: string, dstRoot: string): CopySummary {
  const files: string[] = [];
  collectMarkdownFiles(srcRoot, srcRoot, files);
  let copied = 0;
  let skipped = 0;
  for (const rel of files) {
    const src = path.join(srcRoot, rel);
    const dst = path.join(dstRoot, rel);
    try {
      const srcStat = fs.statSync(src);
      if (fs.existsSync(dst)) {
        const dstStat = fs.statSync(dst);
        if (dstStat.mtimeMs >= srcStat.mtimeMs && dstStat.size === srcStat.size) {
          skipped += 1;
          continue;
        }
      }
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      copied += 1;
    } catch {
      skipped += 1;
    }
  }
  return { copied, skipped };
}

function buildProviderContext(
  provider: DocsProviderView,
  snapshotRoot: string,
): { block: string; hasPinnedNote: boolean; hasProjectOverview: boolean } {
  const files: string[] = [];
  collectMarkdownFiles(snapshotRoot, snapshotRoot, files);

  const preview = files
    .slice(0, MAX_CONTEXT_NOTE_LINES)
    .map((rel) => `- ${titleFromPath(rel)} (${rel})`)
    .join("\n");

  const pinned = readPinnedNote(snapshotRoot);
  const pinnedBlock = pinned
    ? [
        `[Project Context — ${pinned.relPath}]`,
        pinned.content,
        pinned.content.length === MAX_PINNED_CONTENT_CHARS ? "… (truncated)" : "",
      ]
        .filter(Boolean)
        .join("\n")
    : "";

  const block = [
    `[Docs Provider] ${provider.name}`,
    `- provider_id: ${provider.id}`,
    `- provider_type: ${provider.providerType}`,
    `- vault_path: ${provider.vaultPath}`,
    `- workspace_snapshot: ${snapshotRoot}`,
    `- mode: ${provider.readOnly ? "read-only" : "read-write"}`,
    pinnedBlock,
    files.length > 0 ? "- available_notes:" : "- available_notes: (none yet)",
    preview,
  ]
    .filter(Boolean)
    .join("\n");

  const hasProjectOverview =
    pinned?.relPath === "Project Overview.md" || fs.existsSync(path.join(snapshotRoot, "Project Overview.md"));
  return { block, hasPinnedNote: pinned !== null, hasProjectOverview };
}

export function buildDocsExecutionContextBlock(input: {
  db: DbLike;
  task: TaskLike;
  worktreePath: string;
  appendTaskLog?: (taskId: string, kind: string, message: string) => void;
}): TaskDocsContextBundle {
  const providers = resolveTaskDocsProviders(input.db, {
    project_id: input.task.project_id ?? null,
    project_path: input.task.project_path ?? null,
  });
  if (providers.length === 0) {
    return { contextBlock: "", providerIds: [] };
  }

  const taskId = String(input.task.id || "").trim();
  const blocks: string[] = [];
  const providerIds: string[] = [];
  let hasProjectOverview = false;

  for (const provider of providers) {
    try {
      const connector = createConnector(provider);
      connector.assertVaultReady();

      const snapshotRoot = path.join(input.worktreePath, PROJECT_STATE_DIR_NAME, "docs", provider.id);
      fs.mkdirSync(snapshotRoot, { recursive: true });
      const summary = copyMarkdownTree(provider.vaultPath, snapshotRoot);
      providerIds.push(provider.id);

      if (taskId && input.appendTaskLog) {
        input.appendTaskLog(
          taskId,
          "system",
          `Docs sync (vault->worktree): provider=${provider.id} copied=${summary.copied} skipped=${summary.skipped}`,
        );
      }

      const { block, hasProjectOverview: providerHasProjectOverview } = buildProviderContext(provider, snapshotRoot);
      blocks.push(block);
      if (providerHasProjectOverview) hasProjectOverview = true;
    } catch (err: unknown) {
      if (taskId && input.appendTaskLog) {
        input.appendTaskLog(
          taskId,
          "system",
          `Docs sync skipped for provider=${provider.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  if (blocks.length === 0) return { contextBlock: "", providerIds: [] };

  const docsRules = [
    "[Docs Skills]",
    `- note_taking: ${DOCS_SKILLS_PROFILE.note_taking}`,
    `- knowledge_retrieval: ${DOCS_SKILLS_PROFILE.knowledge_retrieval}`,
    `- document_linking: ${DOCS_SKILLS_PROFILE.document_linking}`,
    `- tag_management: ${DOCS_SKILLS_PROFILE.tag_management}`,
    "",
    "[Docs Execution Rules]",
    "- For note edits, prioritize markdown files inside each workspace_snapshot path.",
    "- Preserve and generate Obsidian-style [[wikilinks]] when referencing notes.",
    "- Treat docs changes as bidirectional sync targets (worktree snapshot -> vault on successful run).",
    !hasProjectOverview
      ? "- No Project Overview exists yet in this vault. If your task generates documentation or project context, create 'Project Overview.md' in the snapshot root with a concise summary of the project: purpose, architecture, key conventions, and important decisions."
      : "- Keep the existing Project Overview.md up to date if your task introduces architectural changes or key decisions.",
  ].join("\n");

  return {
    contextBlock: [docsRules, ...blocks].join("\n\n"),
    providerIds,
  };
}

export function syncTaskDocsBackToVault(input: {
  db: DbLike;
  task: TaskLike;
  taskWorktrees: Map<string, { worktreePath: string; branchName: string; projectPath: string }>;
  appendTaskLog?: (taskId: string, kind: string, message: string) => void;
}): { syncedProviders: number; copiedFiles: number } {
  const taskId = String(input.task.id || "").trim();
  if (!taskId) return { syncedProviders: 0, copiedFiles: 0 };

  const wt = input.taskWorktrees.get(taskId);
  if (!wt?.worktreePath) return { syncedProviders: 0, copiedFiles: 0 };

  const providers = resolveTaskDocsProviders(input.db, {
    project_id: input.task.project_id ?? null,
    project_path: input.task.project_path ?? wt.projectPath ?? null,
  });
  if (providers.length === 0) return { syncedProviders: 0, copiedFiles: 0 };

  let syncedProviders = 0;
  let copiedFiles = 0;

  for (const provider of providers) {
    try {
      if (provider.readOnly) continue;
      const connector = createConnector(provider);
      connector.assertVaultReady();

      const snapshotRoot = path.join(wt.worktreePath, PROJECT_STATE_DIR_NAME, "docs", provider.id);
      if (!fs.existsSync(snapshotRoot) || !fs.statSync(snapshotRoot).isDirectory()) continue;

      const summary = copyMarkdownTree(snapshotRoot, provider.vaultPath);
      syncedProviders += 1;
      copiedFiles += summary.copied;

      input.appendTaskLog?.(
        taskId,
        "system",
        `Docs sync (worktree->vault): provider=${provider.id} copied=${summary.copied} skipped=${summary.skipped}`,
      );
    } catch (err: unknown) {
      input.appendTaskLog?.(
        taskId,
        "system",
        `Docs sync back skipped for provider=${provider.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { syncedProviders, copiedFiles };
}
