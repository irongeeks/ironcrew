import type { RuntimeContext } from "../../../types/runtime-context.ts";
import { createSshConnector } from "../../workflow/ssh/ssh-connector.ts";
import { SshConfigSchema } from "../../workflow/ssh/types.ts";
import type { SshConnectorInterface } from "../../workflow/ssh/ssh-connector.ts";
import { shouldRequireCsrf, hasValidCsrfToken, isLoopbackRequest } from "../../../security/auth.ts";
import { parseBody } from "../validation.ts";
import { SshExecSchema, SshMkdirSchema, SshUploadSchema, SshWriteSchema } from "../validation-schemas.ts";

export function registerServerSshRoutes(ctx: RuntimeContext): void {
  const { app, db } = ctx;

  function requireLoopback(req: { socket?: { remoteAddress?: string } }, res: any): boolean {
    if (!isLoopbackRequest(req)) {
      res.status(403).json({ error: "loopback_only" });
      return false;
    }
    return true;
  }

  function requireCsrfGuard(req: Parameters<typeof shouldRequireCsrf>[0], res: any): boolean {
    if (!shouldRequireCsrf(req)) return true;
    if (hasValidCsrfToken(req)) return true;
    res.status(403).json({ error: "csrf_token_invalid" });
    return false;
  }

  function loadSshConnector(
    serverId: string,
  ): { error: string; status: number } | { connector: SshConnectorInterface; row: Record<string, unknown> } {
    const row = db.prepare("SELECT * FROM servers WHERE id = ?").get(serverId) as Record<string, unknown> | undefined;
    if (!row) return { error: "server_not_found", status: 404 };
    if (!row.ssh_config_json) return { error: "no_ssh_config", status: 400 };
    const parsed = SshConfigSchema.safeParse(JSON.parse(row.ssh_config_json as string));
    if (!parsed.success) return { error: "invalid_ssh_config", status: 500 };
    return { connector: createSshConnector(parsed.data), row };
  }

  // GET /api/ops/servers/:id/ssh/status
  app.get("/api/ops/servers/:id/ssh/status", async (req, res) => {
    if (!requireLoopback(req, res)) return;
    const r = loadSshConnector(req.params.id);
    if ("error" in r) return res.status(r.status).json({ error: r.error });
    const start = Date.now();
    const connected = await r.connector.testConnection();
    res.json({ connected, latency_ms: Date.now() - start });
  });

  // POST /api/ops/servers/:id/ssh/test
  app.post("/api/ops/servers/:id/ssh/test", async (req, res) => {
    if (!requireLoopback(req, res)) return;
    if (!requireCsrfGuard(req, res)) return;
    const r = loadSshConnector(req.params.id);
    if ("error" in r) return res.status(r.status).json({ error: r.error });
    try {
      const ok = await r.connector.testConnection();
      res.json({ success: ok, error: ok ? undefined : "Connection failed" });
    } catch (err) {
      res.json({ success: false, error: String(err) });
    }
  });

  // GET /api/ops/servers/:id/fs/list
  app.get("/api/ops/servers/:id/fs/list", async (req, res) => {
    if (!requireLoopback(req, res)) return;
    const r = loadSshConnector(req.params.id);
    if ("error" in r) return res.status(r.status).json({ error: r.error });
    const path = (req.query.path as string) || "~";
    try {
      const entries = await r.connector.listDirectory(path);
      res.json({ entries, path });
    } catch (err) {
      console.error("[ssh] list_failed:", err);
      res.status(500).json({ error: "list_failed" });
    }
  });

  // POST /api/ops/servers/:id/fs/mkdir
  app.post("/api/ops/servers/:id/fs/mkdir", async (req, res) => {
    if (!requireLoopback(req, res)) return;
    if (!requireCsrfGuard(req, res)) return;
    const r = loadSshConnector(req.params.id);
    if ("error" in r) return res.status(r.status).json({ error: r.error });
    const parsed = parseBody(SshMkdirSchema, req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error });
    const { path } = parsed.data;
    try {
      await r.connector.createDirectory(path);
      res.json({ success: true, path });
    } catch (err) {
      console.error("[ssh] mkdir_failed:", err);
      res.status(500).json({ error: "mkdir_failed" });
    }
  });

  // GET /api/ops/servers/:id/fs/read
  app.get("/api/ops/servers/:id/fs/read", async (req, res) => {
    if (!requireLoopback(req, res)) return;
    const r = loadSshConnector(req.params.id);
    if ("error" in r) return res.status(r.status).json({ error: r.error });
    const path = req.query.path as string;
    if (!path) return res.status(400).json({ error: "path_required" });
    try {
      const [content, stat] = await Promise.all([r.connector.readFile(path), r.connector.stat(path)]);
      res.json({ content, stat });
    } catch (err) {
      console.error("[ssh] read_failed:", err);
      res.status(500).json({ error: "read_failed" });
    }
  });

  // PUT /api/ops/servers/:id/fs/write
  app.put("/api/ops/servers/:id/fs/write", async (req, res) => {
    if (!requireLoopback(req, res)) return;
    if (!requireCsrfGuard(req, res)) return;
    const r = loadSshConnector(req.params.id);
    if ("error" in r) return res.status(r.status).json({ error: r.error });
    const parsed = parseBody(SshWriteSchema, req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error });
    const { path, content } = parsed.data;
    try {
      await r.connector.writeFile(path, content);
      res.json({ success: true, path });
    } catch (err) {
      console.error("[ssh] write_failed:", err);
      res.status(500).json({ error: "write_failed" });
    }
  });

  // DELETE /api/ops/servers/:id/fs/delete
  app.delete("/api/ops/servers/:id/fs/delete", async (req, res) => {
    if (!requireLoopback(req, res)) return;
    if (!requireCsrfGuard(req, res)) return;
    const r = loadSshConnector(req.params.id);
    if ("error" in r) return res.status(r.status).json({ error: r.error });
    const path = req.query.path as string;
    if (!path) return res.status(400).json({ error: "path_required" });
    try {
      await r.connector.deleteFile(path);
      res.json({ success: true, path });
    } catch (err) {
      console.error("[ssh] delete_failed:", err);
      res.status(500).json({ error: "delete_failed" });
    }
  });

  // GET /api/ops/servers/:id/fs/stat
  app.get("/api/ops/servers/:id/fs/stat", async (req, res) => {
    if (!requireLoopback(req, res)) return;
    const r = loadSshConnector(req.params.id);
    if ("error" in r) return res.status(r.status).json({ error: r.error });
    const path = req.query.path as string;
    if (!path) return res.status(400).json({ error: "path_required" });
    try {
      const stat = await r.connector.stat(path);
      res.json(stat);
    } catch (err) {
      console.error("[ssh] stat_failed:", err);
      res.status(500).json({ error: "stat_failed" });
    }
  });

  // POST /api/ops/servers/:id/ssh/exec
  app.post("/api/ops/servers/:id/ssh/exec", async (req, res) => {
    if (!requireLoopback(req, res)) return;
    if (!requireCsrfGuard(req, res)) return;
    const r = loadSshConnector(req.params.id);
    if ("error" in r) return res.status(r.status).json({ error: r.error });
    const parsed = parseBody(SshExecSchema, req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error });
    const { command } = parsed.data;
    try {
      const result = await r.connector.exec(command);
      res.json(result);
    } catch (err) {
      console.error("[ssh] command_rejected:", err);
      res.status(403).json({ error: "command_rejected" });
    }
  });

  // GET /api/ops/servers/:id/ssh/download
  app.get("/api/ops/servers/:id/ssh/download", async (req, res) => {
    if (!requireLoopback(req, res)) return;
    const r = loadSshConnector(req.params.id);
    if ("error" in r) return res.status(r.status).json({ error: r.error });
    const remotePath = req.query.path as string;
    if (!remotePath) return res.status(400).json({ error: "path_required" });
    try {
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const { createReadStream, unlinkSync } = await import("node:fs");
      const localTmp = join(tmpdir(), `ironcrew-dl-${Date.now()}`);
      await r.connector.downloadFile(remotePath, localTmp);
      const filename = remotePath.split("/").pop() || "download";
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      const stream = createReadStream(localTmp);
      stream.pipe(res);
      stream.on("end", () => {
        try {
          unlinkSync(localTmp);
        } catch {
          /* best effort */
        }
      });
    } catch (err) {
      console.error("[ssh] download_failed:", err);
      res.status(500).json({ error: "download_failed" });
    }
  });

  // POST /api/ops/servers/:id/ssh/upload
  app.post("/api/ops/servers/:id/ssh/upload", async (req, res) => {
    if (!requireLoopback(req, res)) return;
    if (!requireCsrfGuard(req, res)) return;
    const r = loadSshConnector(req.params.id);
    if ("error" in r) return res.status(r.status).json({ error: r.error });
    const parsed = parseBody(SshUploadSchema, req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error });
    const { remote_path, content_base64 } = parsed.data;
    try {
      const { writeFileSync, unlinkSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const localTmp = join(tmpdir(), `ironcrew-ul-${Date.now()}`);
      writeFileSync(localTmp, Buffer.from(content_base64, "base64"));
      await r.connector.uploadFile(localTmp, remote_path);
      try {
        unlinkSync(localTmp);
      } catch {
        /* best effort */
      }
      res.json({ success: true, path: remote_path });
    } catch (err) {
      console.error("[ssh] upload_failed:", err);
      res.status(500).json({ error: "upload_failed" });
    }
  });
}
