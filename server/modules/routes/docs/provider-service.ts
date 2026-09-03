import { randomUUID } from "node:crypto";
import path from "node:path";
import type { DocsProviderBindingRow, DocsProviderRow, DocsProviderView, DocsSkillsProfile } from "./types.ts";
import { ObsidianLocalConnector } from "./obsidian-local-connector.ts";

type DbLike = {
  prepare: (sql: string) => {
    all: (...args: any[]) => unknown;
    get: (...args: any[]) => unknown;
    run: (...args: any[]) => unknown;
  };
};

export const DOCS_SKILLS_PROFILE: DocsSkillsProfile = {
  note_taking:
    "Create/update concise markdown notes with clear headings, action items, and project context. Preserve existing structure when extending notes.",
  knowledge_retrieval:
    "Search vault notes by semantic keywords, tags, and wikilinks; prioritize title + heading matches and provide source note paths.",
  document_linking:
    "Generate and maintain Obsidian [[wikilinks]] between related notes; include backlinks-friendly targets and stable note titles.",
  tag_management:
    "Apply and normalize #tags consistently for categorization, retrieval, and lifecycle status tracking.",
};

function parseMetadata(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function normalizeAbsolutePath(value: string | null | undefined): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed ? path.resolve(trimmed) : null;
}

function isSameOrChildPath(root: string | null | undefined, candidate: string | null | undefined): boolean {
  const normalizedRoot = normalizeAbsolutePath(root);
  const normalizedCandidate = normalizeAbsolutePath(candidate);
  if (!normalizedRoot || !normalizedCandidate) return false;
  if (normalizedRoot === normalizedCandidate) return true;
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function toDocsProviderView(row: DocsProviderRow): DocsProviderView {
  return {
    id: row.id,
    name: row.name,
    providerType: row.provider_type,
    vaultPath: row.vault_path,
    enabled: row.enabled === 1,
    readOnly: row.read_only === 1,
    metadata: parseMetadata(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listDocsProviders(db: DbLike): DocsProviderView[] {
  const rows = db
    .prepare(
      `
    SELECT *
    FROM docs_providers
    ORDER BY updated_at DESC, created_at DESC
  `,
    )
    .all() as DocsProviderRow[];
  return rows.map(toDocsProviderView);
}

export function getDocsProviderById(db: DbLike, providerId: string): DocsProviderView | null {
  const row = db.prepare("SELECT * FROM docs_providers WHERE id = ?").get(providerId) as DocsProviderRow | undefined;
  if (!row) return null;
  return toDocsProviderView(row);
}

export function createDocsProvider(
  db: DbLike,
  nowMs: () => number,
  input: {
    name: string;
    vaultPath: string;
    enabled?: boolean;
    readOnly?: boolean;
    metadata?: Record<string, unknown> | null;
  },
): DocsProviderView {
  const id = randomUUID();
  const ts = nowMs();
  const normalizedPath = path.resolve(String(input.vaultPath || "").trim());
  db.prepare(
    `
    INSERT INTO docs_providers (
      id, name, provider_type, vault_path, enabled, read_only, metadata_json, created_at, updated_at
    ) VALUES (?, ?, 'obsidian_local', ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    id,
    String(input.name || "").trim() || "Obsidian Vault",
    normalizedPath,
    input.enabled === false ? 0 : 1,
    input.readOnly ? 1 : 0,
    input.metadata ? JSON.stringify(input.metadata) : null,
    ts,
    ts,
  );

  const provider = getDocsProviderById(db, id);
  if (!provider) throw new Error("provider_create_failed");
  return provider;
}

export function updateDocsProvider(
  db: DbLike,
  nowMs: () => number,
  providerId: string,
  input: {
    name?: string;
    vaultPath?: string;
    enabled?: boolean;
    readOnly?: boolean;
    metadata?: Record<string, unknown> | null;
  },
): DocsProviderView | null {
  const updates: string[] = [];
  const values: unknown[] = [];

  if (typeof input.name === "string") {
    updates.push("name = ?");
    values.push(input.name.trim() || "Obsidian Vault");
  }
  if (typeof input.vaultPath === "string") {
    updates.push("vault_path = ?");
    values.push(path.resolve(input.vaultPath.trim()));
  }
  if (typeof input.enabled === "boolean") {
    updates.push("enabled = ?");
    values.push(input.enabled ? 1 : 0);
  }
  if (typeof input.readOnly === "boolean") {
    updates.push("read_only = ?");
    values.push(input.readOnly ? 1 : 0);
  }
  if (input.metadata !== undefined) {
    updates.push("metadata_json = ?");
    values.push(input.metadata ? JSON.stringify(input.metadata) : null);
  }

  if (updates.length === 0) return getDocsProviderById(db, providerId);
  updates.push("updated_at = ?");
  values.push(nowMs());

  db.prepare(`UPDATE docs_providers SET ${updates.join(", ")} WHERE id = ?`).run(...values, providerId);
  return getDocsProviderById(db, providerId);
}

export function deleteDocsProvider(db: DbLike, providerId: string): boolean {
  db.prepare("DELETE FROM docs_provider_bindings WHERE provider_id = ?").run(providerId);
  const result = db.prepare("DELETE FROM docs_providers WHERE id = ?").run(providerId) as { changes?: number };
  return (result?.changes ?? 0) > 0;
}

export function listDocsProviderBindings(db: DbLike, providerId: string): DocsProviderBindingRow[] {
  return db
    .prepare(
      `
    SELECT id, provider_id, project_id, project_path_prefix, created_at
    FROM docs_provider_bindings
    WHERE provider_id = ?
    ORDER BY created_at DESC
  `,
    )
    .all(providerId) as DocsProviderBindingRow[];
}

export function upsertDocsProviderBinding(
  db: DbLike,
  nowMs: () => number,
  input: {
    providerId: string;
    projectId?: string | null;
    projectPathPrefix?: string | null;
  },
): DocsProviderBindingRow {
  const id = randomUUID();
  const ts = nowMs();
  const projectId = input.projectId ? String(input.projectId).trim() : null;
  const prefixRaw = input.projectPathPrefix ? String(input.projectPathPrefix).trim() : null;
  const projectPathPrefix = prefixRaw ? path.resolve(prefixRaw) : null;

  db.prepare(
    `
    INSERT INTO docs_provider_bindings (
      id, provider_id, project_id, project_path_prefix, created_at
    ) VALUES (?, ?, ?, ?, ?)
  `,
  ).run(id, input.providerId, projectId, projectPathPrefix, ts);

  const row = db
    .prepare(
      `
    SELECT id, provider_id, project_id, project_path_prefix, created_at
    FROM docs_provider_bindings
    WHERE id = ?
  `,
    )
    .get(id) as DocsProviderBindingRow | undefined;

  if (!row) throw new Error("binding_create_failed");
  return row;
}

export function deleteDocsProviderBinding(db: DbLike, bindingId: string): boolean {
  const result = db.prepare("DELETE FROM docs_provider_bindings WHERE id = ?").run(bindingId) as { changes?: number };
  return (result?.changes ?? 0) > 0;
}

export function resolveTaskDocsProviders(
  db: DbLike,
  task: { project_id?: string | null; project_path?: string | null },
): DocsProviderView[] {
  const projectId = task.project_id ? String(task.project_id).trim() : null;
  const projectPath = normalizeAbsolutePath(task.project_path);

  const boundRows = db
    .prepare(
      `
    SELECT DISTINCT p.*, b.project_id AS binding_project_id, b.project_path_prefix AS binding_project_path_prefix
    FROM docs_providers p
    JOIN docs_provider_bindings b ON b.provider_id = p.id
    WHERE p.enabled = 1
      AND (
        (b.project_id IS NOT NULL AND b.project_id = ?)
        OR (b.project_id IS NULL AND b.project_path_prefix IS NOT NULL)
        OR (b.project_id IS NULL AND b.project_path_prefix IS NULL)
      )
    ORDER BY p.updated_at DESC
  `,
    )
    .all(projectId) as Array<
    DocsProviderRow & {
      binding_project_id?: string | null;
      binding_project_path_prefix?: string | null;
    }
  >;

  const filteredBoundRows = boundRows.filter((row) => {
    if (row.binding_project_id && row.binding_project_id === projectId) return true;
    if (!row.binding_project_id && !row.binding_project_path_prefix) return true;
    return isSameOrChildPath(row.binding_project_path_prefix, projectPath);
  });

  if (filteredBoundRows.length > 0) return filteredBoundRows.map(toDocsProviderView);

  if (!projectPath) return [];
  const fallbackRows = db
    .prepare(
      `
    SELECT *
    FROM docs_providers
    WHERE enabled = 1
    ORDER BY updated_at DESC
  `,
    )
    .all() as DocsProviderRow[];

  return fallbackRows
    .filter((row) => {
      const vaultPath = normalizeAbsolutePath(row.vault_path);
      return isSameOrChildPath(vaultPath, projectPath) || isSameOrChildPath(projectPath, vaultPath);
    })
    .map(toDocsProviderView);
}

export function createConnector(provider: DocsProviderView): ObsidianLocalConnector {
  if (provider.providerType !== "obsidian_local") {
    throw new Error("unsupported_provider_type");
  }
  return new ObsidianLocalConnector(provider);
}
