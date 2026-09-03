import type { Express } from "express";
import { logger } from "../../../observability/logger.ts";
import { requireAuth } from "../../../security/auth.ts";
import { parseBody } from "../validation.ts";
import {
  DocsProviderCreateSchema,
  DocsProviderUpdateSchema,
  DocsBindingCreateSchema,
  DocsNoteWriteSchema,
  DocsNoteCreateSchema,
  DocsSearchSchema,
  DocsWikilinkFormatSchema,
} from "../validation-schemas.ts";
import {
  DOCS_SKILLS_PROFILE,
  createConnector,
  createDocsProvider,
  deleteDocsProvider,
  deleteDocsProviderBinding,
  getDocsProviderById,
  listDocsProviderBindings,
  listDocsProviders,
  resolveTaskDocsProviders,
  toDocsProviderView,
  updateDocsProvider,
  upsertDocsProviderBinding,
} from "./provider-service.ts";
import { syncTaskDocsBackToVault } from "./task-docs-sync.ts";
import { extractTags, extractWikilinks, toWikilink, upsertTags } from "./wikilinks.ts";
import type { DocsProviderRow } from "./types.ts";

function safeErrorResponse(res: any, status: number, errorCode: string, err: unknown) {
  logger.error({ module: "docs", err }, `[docs] ${errorCode}`);
  res.status(status).json({ error: errorCode });
}

type DbLike = {
  prepare: (sql: string) => {
    all: (...args: any[]) => unknown;
    get: (...args: any[]) => unknown;
    run: (...args: any[]) => unknown;
  };
};

type RegisterDocsRoutesDeps = {
  app: Express;
  db: DbLike;
  nowMs: () => number;
  appendTaskLog: (taskId: string, kind: string, message: string) => void;
  taskWorktrees: Map<string, { worktreePath: string; branchName: string; projectPath: string }>;
};

function getProviderOr404(db: DbLike, res: any, providerId: string) {
  const provider = getDocsProviderById(db, providerId);
  if (!provider) {
    res.status(404).json({ ok: false, error: "provider_not_found" });
    return null;
  }
  return provider;
}

export function registerDocsRoutes(deps: RegisterDocsRoutesDeps): void {
  const { app, db, nowMs, appendTaskLog, taskWorktrees } = deps;
  app.use("/api/knowledge/docs", requireAuth);

  app.get("/api/knowledge/docs/skills", (_req, res) => {
    res.json({ ok: true, skills: DOCS_SKILLS_PROFILE });
  });

  app.get("/api/knowledge/docs/providers", (_req, res) => {
    const providers = listDocsProviders(db);
    res.json({ ok: true, providers });
  });

  app.post("/api/knowledge/docs/providers", (req, res) => {
    try {
      const parsed = parseBody(DocsProviderCreateSchema, req.body);
      if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error });
      const body = parsed.data;
      const provider = createDocsProvider(db, nowMs, {
        name: String(body.name || "").trim() || "Obsidian Vault",
        vaultPath: String(body.vaultPath).trim(),
        enabled: body.enabled,
        readOnly: body.readOnly,
        metadata: body.metadata,
      });
      res.json({ ok: true, provider });
    } catch (err: unknown) {
      safeErrorResponse(res, 500, "provider_create_failed", err);
    }
  });

  app.patch("/api/knowledge/docs/providers/:id", (req, res) => {
    const providerId = String(req.params.id);
    const existing = getProviderOr404(db, res, providerId);
    if (!existing) return;

    try {
      const parsed = parseBody(DocsProviderUpdateSchema, req.body);
      if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error });
      const body = parsed.data;
      const provider = updateDocsProvider(db, nowMs, providerId, body);
      res.json({ ok: true, provider });
    } catch (err: unknown) {
      safeErrorResponse(res, 500, "provider_update_failed", err);
    }
  });

  app.delete("/api/knowledge/docs/providers/:id", (req, res) => {
    const providerId = String(req.params.id);
    const ok = deleteDocsProvider(db, providerId);
    if (!ok) return res.status(404).json({ ok: false, error: "provider_not_found" });
    res.json({ ok: true });
  });

  app.get("/api/knowledge/docs/providers/:id/test", (req, res) => {
    const providerId = String(req.params.id);
    const provider = getProviderOr404(db, res, providerId);
    if (!provider) return;

    try {
      const connector = createConnector(provider);
      connector.assertVaultReady();
      const noteCount = connector.listNotes(20).length;
      res.json({ ok: true, reachable: true, previewCount: noteCount });
    } catch (err: unknown) {
      logger.error({ module: "docs", err }, "[docs] provider_test_failed");
      res.status(400).json({ ok: false, reachable: false, error: "provider_test_failed" });
    }
  });

  app.get("/api/knowledge/docs/providers/:id/bindings", (req, res) => {
    const providerId = String(req.params.id);
    const provider = getProviderOr404(db, res, providerId);
    if (!provider) return;

    const bindings = listDocsProviderBindings(db, providerId);
    res.json({ ok: true, bindings });
  });

  app.post("/api/knowledge/docs/providers/:id/bindings", (req, res) => {
    const providerId = String(req.params.id);
    const provider = getProviderOr404(db, res, providerId);
    if (!provider) return;

    try {
      const parsed = parseBody(DocsBindingCreateSchema, req.body);
      if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error });
      const body = parsed.data;
      const binding = upsertDocsProviderBinding(db, nowMs, {
        providerId,
        projectId: body.projectId ?? null,
        projectPathPrefix: body.projectPathPrefix ?? null,
      });
      res.json({ ok: true, binding });
    } catch (err: unknown) {
      safeErrorResponse(res, 500, "binding_create_failed", err);
    }
  });

  app.delete("/api/knowledge/docs/bindings/:bindingId", (req, res) => {
    const bindingId = String(req.params.bindingId);
    const ok = deleteDocsProviderBinding(db, bindingId);
    if (!ok) return res.status(404).json({ ok: false, error: "binding_not_found" });
    res.json({ ok: true });
  });

  app.get("/api/knowledge/docs/providers/:id/notes", (req, res) => {
    const providerId = String(req.params.id);
    const provider = getProviderOr404(db, res, providerId);
    if (!provider) return;

    try {
      const connector = createConnector(provider);
      const limit = Number(req.query.limit ?? 200);
      const notes = connector.listNotes(limit);
      res.json({ ok: true, notes });
    } catch (err: unknown) {
      safeErrorResponse(res, 400, "notes_list_failed", err);
    }
  });

  app.get("/api/knowledge/docs/providers/:id/notes/content", (req, res) => {
    const providerId = String(req.params.id);
    const provider = getProviderOr404(db, res, providerId);
    if (!provider) return;

    const notePath = String(req.query.path || req.query.target || "").trim();
    if (!notePath) return res.status(400).json({ ok: false, error: "path_required" });

    try {
      const connector = createConnector(provider);
      const note = connector.readNote(notePath);
      res.json({ ok: true, note });
    } catch (err: unknown) {
      safeErrorResponse(res, 400, "note_read_failed", err);
    }
  });

  app.put("/api/knowledge/docs/providers/:id/notes/content", (req, res) => {
    const providerId = String(req.params.id);
    const provider = getProviderOr404(db, res, providerId);
    if (!provider) return;

    const parsed = parseBody(DocsNoteWriteSchema, req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error });
    const body = parsed.data;

    try {
      const connector = createConnector(provider);
      let content = body.content ?? "";
      if (body.tags && body.tags.length > 0) {
        content = upsertTags(content, body.tags);
      }
      const updated = connector.writeNote(body.path, content);
      res.json({ ok: true, updated });
    } catch (err: unknown) {
      safeErrorResponse(res, 400, "note_write_failed", err);
    }
  });

  app.post("/api/knowledge/docs/providers/:id/notes", (req, res) => {
    const providerId = String(req.params.id);
    const provider = getProviderOr404(db, res, providerId);
    if (!provider) return;

    const parsed = parseBody(DocsNoteCreateSchema, req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error });
    const body = parsed.data;

    try {
      const connector = createConnector(provider);
      let content = body.content ?? "";
      if (body.tags && body.tags.length > 0) {
        content = upsertTags(content, body.tags);
      }
      const created = connector.createNote(body.title, content, body.folder ?? "");
      res.json({ ok: true, created });
    } catch (err: unknown) {
      safeErrorResponse(res, 400, "note_create_failed", err);
    }
  });

  app.post("/api/knowledge/docs/providers/:id/search", (req, res) => {
    const providerId = String(req.params.id);
    const provider = getProviderOr404(db, res, providerId);
    if (!provider) return;

    const parsed = parseBody(DocsSearchSchema, req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error });
    const body = parsed.data;

    try {
      const connector = createConnector(provider);
      const results = connector.search({
        query: body.query,
        limit: body.limit,
        tags: body.tags,
      });
      res.json({ ok: true, results });
    } catch (err: unknown) {
      safeErrorResponse(res, 400, "search_failed", err);
    }
  });

  app.get("/api/knowledge/docs/providers/:id/backlinks", (req, res) => {
    const providerId = String(req.params.id);
    const provider = getProviderOr404(db, res, providerId);
    if (!provider) return;

    const target = String(req.query.target || req.query.path || "").trim();
    if (!target) return res.status(400).json({ ok: false, error: "target_required" });

    try {
      const connector = createConnector(provider);
      const backlinks = connector.backlinks(target);
      res.json({ ok: true, backlinks });
    } catch (err: unknown) {
      safeErrorResponse(res, 400, "backlinks_failed", err);
    }
  });

  app.post("/api/knowledge/docs/wikilinks/format", (req, res) => {
    const parsed = parseBody(DocsWikilinkFormatSchema, req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error });
    const body = parsed.data;

    const wikilink = toWikilink(body.target, body.alias);
    const extractedFromContent = body.content
      ? {
          tags: extractTags(String(body.content)),
          wikilinks: extractWikilinks(String(body.content)),
        }
      : null;

    res.json({ ok: true, wikilink, extracted: extractedFromContent });
  });

  app.get("/api/knowledge/docs/tasks/:taskId/providers", (req, res) => {
    const taskId = String(req.params.taskId);
    const task = db.prepare("SELECT id, project_id, project_path FROM tasks WHERE id = ?").get(taskId) as
      | { id: string; project_id: string | null; project_path: string | null }
      | undefined;
    if (!task) return res.status(404).json({ ok: false, error: "task_not_found" });

    const providers = resolveTaskDocsProviders(db, task);
    res.json({ ok: true, providers });
  });

  app.post("/api/knowledge/docs/tasks/:taskId/sync", (req, res) => {
    const taskId = String(req.params.taskId);
    const task = db.prepare("SELECT id, project_id, project_path, title FROM tasks WHERE id = ?").get(taskId) as
      | { id: string; project_id: string | null; project_path: string | null; title: string }
      | undefined;
    if (!task) return res.status(404).json({ ok: false, error: "task_not_found" });

    const syncResult = syncTaskDocsBackToVault({
      db,
      task,
      taskWorktrees,
      appendTaskLog,
    });

    appendTaskLog(
      taskId,
      "system",
      `Docs sync triggered manually: providers=${syncResult.syncedProviders}, copied=${syncResult.copiedFiles}`,
    );

    res.json({ ok: true, sync: syncResult });
  });

  app.get("/api/knowledge/docs/providers/:id/raw", (req, res) => {
    const providerId = String(req.params.id);
    const row = db.prepare("SELECT * FROM docs_providers WHERE id = ?").get(providerId) as DocsProviderRow | undefined;
    if (!row) return res.status(404).json({ ok: false, error: "provider_not_found" });
    res.json({ ok: true, provider: toDocsProviderView(row) });
  });
}
