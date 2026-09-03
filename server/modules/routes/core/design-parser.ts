import type { Express } from "express";
import type { DatabaseSync } from "node:sqlite";
import { requireAuth } from "../../../security/auth.ts";
import fs from "node:fs";
import path from "node:path";

interface DesignParserDeps {
  app: Express;
  db: DatabaseSync;
  normalizeTextField(value: unknown): string | null;
}

type FigmaParsedRef = {
  provider: "figma";
  fileKey: string;
  nodeId: string | null;
  url: string;
};

function parseFigmaUrl(input: string): FigmaParsedRef | null {
  const text = String(input || "").trim();
  if (!text) return null;

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }

  if (!/figma\.com$/i.test(url.hostname) && !/\.figma\.com$/i.test(url.hostname)) {
    return null;
  }

  const pathParts = url.pathname.split("/").filter(Boolean);
  const fileIndex = pathParts.findIndex((part) => part === "file" || part === "design");
  const fileKey = fileIndex >= 0 ? (pathParts[fileIndex + 1] ?? "") : "";
  if (!fileKey) return null;

  const nodeId = url.searchParams.get("node-id");
  return {
    provider: "figma",
    fileKey,
    nodeId: nodeId ? nodeId.trim() : null,
    url: text,
  };
}

async function fetchFigmaJson(url: string, token: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "X-Figma-Token": token,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      return { error: `figma_api_http_${response.status}` };
    }

    return await response.json();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: message || "figma_api_request_failed" };
  } finally {
    clearTimeout(timeout);
  }
}

function summarizeFigmaFile(raw: unknown): Record<string, unknown> {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const document = obj.document && typeof obj.document === "object" ? (obj.document as Record<string, unknown>) : {};
  const children = Array.isArray(document.children) ? (document.children as Array<Record<string, unknown>>) : [];

  const pages = children.slice(0, 20).map((page) => ({
    id: String(page.id ?? "").trim(),
    name: String(page.name ?? "").trim(),
    type: String(page.type ?? "").trim(),
    childrenCount: Array.isArray(page.children) ? page.children.length : 0,
  }));

  const components = obj.components && typeof obj.components === "object" ? Object.keys(obj.components).length : 0;
  const styles = obj.styles && typeof obj.styles === "object" ? Object.keys(obj.styles).length : 0;

  return {
    name: String(obj.name ?? "").trim() || null,
    lastModified: String(obj.lastModified ?? "").trim() || null,
    thumbnailUrl: String(obj.thumbnailUrl ?? "").trim() || null,
    version: String(obj.version ?? "").trim() || null,
    componentCount: components,
    styleCount: styles,
    pages,
  };
}

function summarizeFigmaNode(raw: unknown): Record<string, unknown> {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const nodes = obj.nodes && typeof obj.nodes === "object" ? (obj.nodes as Record<string, unknown>) : {};
  const firstNode = Object.values(nodes)[0];
  const doc =
    firstNode && typeof firstNode === "object" && (firstNode as Record<string, unknown>).document
      ? ((firstNode as Record<string, unknown>).document as Record<string, unknown>)
      : null;

  if (!doc) return {};

  return {
    id: String(doc.id ?? "").trim() || null,
    name: String(doc.name ?? "").trim() || null,
    type: String(doc.type ?? "").trim() || null,
    childrenCount: Array.isArray(doc.children) ? doc.children.length : 0,
  };
}

export function registerDesignParserRoutes(deps: DesignParserDeps): void {
  const { app, db, normalizeTextField } = deps;
  app.post("/api/design/parse-reference", requireAuth, async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const inputUrl = normalizeTextField(body.url) ?? "";
      const inputFileKey = normalizeTextField(body.fileKey) ?? "";
      const inputNodeId = normalizeTextField(body.nodeId) ?? "";

      const parsedFromUrl = parseFigmaUrl(inputUrl);
      const fileKey = parsedFromUrl?.fileKey || inputFileKey;
      const nodeId = parsedFromUrl?.nodeId || inputNodeId || null;

      if (!fileKey) {
        return res
          .status(400)
          .json({ ok: false, error: "figma_file_key_required", message: "A Figma file key is required" });
      }

      const parsed: FigmaParsedRef = {
        provider: "figma",
        fileKey,
        nodeId,
        url: parsedFromUrl?.url || inputUrl || `https://www.figma.com/file/${fileKey}`,
      };

      const token =
        process.env.FIGMA_ACCESS_TOKEN?.trim() ||
        process.env.FIGMA_API_TOKEN?.trim() ||
        process.env.FIGMA_PERSONAL_ACCESS_TOKEN?.trim() ||
        "";

      if (!token) {
        return res.json({ ok: true, parsed, apiAvailable: false, reason: "figma_token_missing" });
      }

      const fileResult = await fetchFigmaJson(`https://api.figma.com/v1/files/${encodeURIComponent(fileKey)}`, token);
      const nodeResult = nodeId
        ? await fetchFigmaJson(
            `https://api.figma.com/v1/files/${encodeURIComponent(fileKey)}/nodes?ids=${encodeURIComponent(nodeId)}`,
            token,
          )
        : null;

      const fileError =
        fileResult && typeof fileResult === "object" && "error" in (fileResult as Record<string, unknown>)
          ? String((fileResult as Record<string, unknown>).error ?? "")
          : "";
      const nodeError =
        nodeResult && typeof nodeResult === "object" && "error" in (nodeResult as Record<string, unknown>)
          ? String((nodeResult as Record<string, unknown>).error ?? "")
          : "";

      return res.json({
        ok: true,
        parsed,
        apiAvailable: true,
        summary: {
          file: summarizeFigmaFile(fileResult),
          node: nodeResult ? summarizeFigmaNode(nodeResult) : null,
        },
        errors: {
          file: fileError || null,
          node: nodeError || null,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return res.status(500).json({ ok: false, error: "internal_error", message });
    }
  });

  app.get("/api/tasks/:id/design-assets", requireAuth, (req, res) => {
    const taskId = String(req.params.id || "").trim();
    if (!taskId) return res.status(400).json({ ok: false, error: "task_id_required", message: "Task ID is required" });

    const task = db.prepare("SELECT project_path FROM tasks WHERE id = ? LIMIT 1").get(taskId) as
      | { project_path?: string | null }
      | undefined;
    const projectPath = String(task?.project_path ?? "").trim();
    if (!projectPath)
      return res
        .status(404)
        .json({ ok: false, error: "task_project_path_missing", message: "Task has no project path" });

    const designTaskDir = path.join(projectPath, "design_output", `task-${taskId.slice(0, 8)}`);
    const manifestPath = path.join(designTaskDir, "manifest.json");
    if (!fs.existsSync(manifestPath)) {
      return res.json({ ok: true, exists: false, outputDir: path.relative(projectPath, designTaskDir) });
    }

    try {
      const raw = fs.readFileSync(manifestPath, "utf8");
      const parsed = JSON.parse(raw);
      return res.json({
        ok: true,
        exists: true,
        outputDir: path.relative(projectPath, designTaskDir),
        manifest: parsed,
      });
    } catch {
      return res
        .status(500)
        .json({ ok: false, error: "design_manifest_read_failed", message: "Failed to read design manifest" });
    }
  });
}
