import path from "node:path";
import { readFile, writeFile, mkdir, lstat } from "node:fs/promises";
import { z } from "zod";
import type { Repository } from "../../packages/persistence/src/index.ts";
import type { RuntimeTool } from "../../packages/runtime/src/engine.ts";
import type { ToolAction, Json } from "../../packages/contracts/src/index.ts";
import { DomainError, sha256, sameScope } from "../../packages/domain/src/index.ts";
import { digest, Workspace } from "../../packages/tools/workspace.ts";
import {
  browserInspectInputSchema,
  browserConfigurationSchema,
  inspectPreview,
  readBrowserConfiguration,
  type BrowserConfiguration,
  type PreviewSnapshot,
} from "../../packages/tools/browser-inspect.ts";
import { previewSecurityHeaders } from "./preview.ts";
const idFor = (value: unknown) => {
  const h = sha256(value);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const active = new WeakSet<Repository>();
const artifactSchema = z.object({
  id: z.uuid(),
  orderId: z.uuid(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  packageSha256: z.string().regex(/^[a-f0-9]{64}$/),
  stack: z.enum(["static", "react", "wordpress"]),
  previewPath: z.string(),
  files: z
    .array(
      z.object({
        path: z.string(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        bytes: z
          .number()
          .int()
          .min(0)
          .max(8 * 1024 * 1024),
      }),
    )
    .max(1024),
});
export class BrowserInspectService {
  readonly options: {
    repo: Repository;
    directory: string;
    configuration?: () => Promise<BrowserConfiguration | undefined>;
  };
  constructor(options: BrowserInspectService["options"]) {
    this.options = options;
  }
  async inspect(input: unknown, action: ToolAction) {
    const valid = browserInspectInputSchema.parse(input),
      { repo, directory } = this.options;
    const stored = await repo.getDocument<ToolAction & { targetId: string }>(action.scope, "action", action.id);
    if (
      !stored ||
      !sameScope(stored.data.scope, action.scope) ||
      stored.data.orderId !== action.orderId ||
      stored.data.toolId !== "browser.inspect" ||
      stored.data.status !== "running" ||
      stored.data.argumentsSha256 !== sha256(input)
    )
      throw new DomainError("browser_action_binding");
    const bound = stored.data;
    const authorize = async () => {
      await repo.assertDispatchAllowed(bound.scope.companyId);
      await repo.assertAuthorized(bound.scope, { action: bound, targetId: bound.targetId, effect: "read" });
    };
    await authorize();
    const doc = await repo.getDocument(bound.scope, "artifact", valid.artifactPreviewId);
    if (!doc) throw new DomainError("artifact_not_found");
    const artifact = artifactSchema.parse(doc.data);
    if (
      artifact.orderId !== bound.orderId ||
      artifact.id !== valid.artifactPreviewId ||
      artifact.packageSha256 !== valid.expectedPackageSha256 ||
      digest(JSON.stringify(artifact.files)) !== artifact.packageSha256
    )
      throw new DomainError("browser_artifact_binding");
    const id = idFor(["browser-inspection", bound.id]);
    const old = await repo.getDocument(bound.scope, "browser-inspection", id);
    if (old) return old.data;
    if (active.has(repo)) throw new DomainError("browser_capacity_busy");
    active.add(repo);
    try {
      const loaded = await (this.options.configuration ?? (() => readBrowserConfiguration(directory)))();
      const configuration = loaded ? browserConfigurationSchema.parse(loaded) : undefined;
      if (!configuration)
        throw new DomainError("browser_capability_missing", "Administrative Chromium configuration is required.");
      const workspace = new Workspace(path.join(directory, "sites", artifact.id));
      const prefix = path.posix.dirname(artifact.previewPath);
      const media: Record<string, string> = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".mjs": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".svg": "image/svg+xml",
        ".woff2": "font/woff2",
        ".json": "application/json",
      };
      const assets = new Map<string, { content: Buffer; headers: Record<string, string> }>();
      let total = 0;
      for (const file of artifact.files) {
        total += file.bytes;
        if (total > 32 * 1024 * 1024) throw new DomainError("browser_preview_limit");
        const resolved = await workspace.resolve(file.path);
        if ((await lstat(resolved)).size !== file.bytes) throw new DomainError("artifact_corrupt");
        const content = await readFile(resolved);
        if (digest(content) !== file.sha256) throw new DomainError("artifact_corrupt");
        if (file.path === artifact.previewPath && file.sha256 !== artifact.sha256)
          throw new DomainError("browser_artifact_binding");
        const relative =
          prefix === "."
            ? file.path
            : file.path.startsWith(prefix + "/")
              ? file.path.slice(prefix.length + 1)
              : undefined;
        const mediaType = media[path.posix.extname(file.path)];
        if (relative && mediaType)
          assets.set(`/${artifact.id}/${relative}`, {
            content,
            headers: previewSecurityHeaders(mediaType, artifact.stack === "react"),
          });
      }
      const snapshot: PreviewSnapshot = {
        entry: `/${artifact.id}/${path.posix.basename(artifact.previewPath)}`,
        assets,
      };
      if (!assets.has(snapshot.entry)) throw new DomainError("browser_preview_missing");
      await authorize();
      const result = await inspectPreview(configuration, snapshot, valid.viewport);
      const fresh = await (this.options.configuration ?? (() => readBrowserConfiguration(directory)))();
      if (sha256(fresh ?? null) !== sha256(configuration)) throw new DomainError("browser_configuration_changed");
      const dom = Buffer.from(JSON.stringify({ source: "untrusted_artifact_dom", ...result.dom }));
      if (dom.length > 512 * 1024) throw new DomainError("browser_evidence_limit");
      const domHash = digest(dom);
      await mkdir(path.join(directory, "blobs"), { recursive: true, mode: 0o700 });
      for (const [hash, bytes] of [
        [result.screenshotSha256, result.screenshot],
        [domHash, dom],
      ] as const) {
        const file = path.join(directory, "blobs", hash);
        await writeFile(file, bytes, { flag: "wx", mode: 0o600 }).catch(async (e: NodeJS.ErrnoException) => {
          if (e.code !== "EEXIST" || digest(await readFile(file)) !== hash) throw new DomainError("blob_corrupt");
        });
      }
      const screenshotArtifactId = idFor([id, "screenshot"]),
        domArtifactId = idFor([id, "dom"]),
        createdAt = new Date().toISOString();
      const report = {
        id,
        orderId: bound.orderId,
        actionId: bound.id,
        artifactPreviewId: artifact.id,
        packageSha256: artifact.packageSha256,
        viewport: valid.viewport,
        createdAt,
        browserVersion: result.browserVersion,
        executableSha256: result.executableSha256,
        sandboxEnabled: result.sandboxEnabled,
        source: "untrusted_artifact_preview",
        state: "review_required",
        checks: result.checks,
        blockedRequests: result.blockedRequests,
        errors: result.errors,
        screenshotArtifactId,
        screenshotSha256: result.screenshotSha256,
        domArtifactId,
        domSha256: domHash,
      };
      const artifactData = (artifactId: string, hash: string, bytes: number, mediaType: string) => ({
        id: artifactId,
        artifactId: id,
        orderId: bound.orderId,
        scope: bound.scope,
        sha256: hash,
        bytes,
        mediaType,
        canonicalStore: "internal",
        delivery: "staged",
        createdAt,
        sourceArtifactVersionId: artifact.id,
      });
      await repo.authorizeAndTransact(
        bound.scope,
        { action: bound, targetId: bound.targetId, effect: "read" },
        [
          {
            kind: "artifact",
            id: screenshotArtifactId,
            data: artifactData(screenshotArtifactId, result.screenshotSha256, result.screenshot.length, "image/png"),
            immutable: true,
          },
          {
            kind: "artifact",
            id: domArtifactId,
            data: artifactData(domArtifactId, domHash, dom.length, "application/json"),
            immutable: true,
          },
          {
            kind: "browser-inspection",
            id,
            data: JSON.parse(JSON.stringify({ ...report, reportSha256: sha256(report) })) as Json,
            immutable: true,
          },
        ],
        { type: "browser.inspected", aggregateId: bound.orderId },
      );
      return { ...report, reportSha256: sha256(report) };
    } finally {
      active.delete(repo);
    }
  }
}
export function browserInspectTools(options: BrowserInspectService["options"]): RuntimeTool[] {
  const service = new BrowserInspectService(options);
  return [
    {
      id: "browser.inspect",
      schema: browserInspectInputSchema,
      description:
        "Inspect only an exact permitted built site artifact version in a sandboxed Chromium with no external network or user session; produce screenshot and bounded DOM checks for lead review. Administrative browser capability required.",
      requiresApproval: false,
      execute: (input, action) => service.inspect(input, action),
    },
  ];
}
