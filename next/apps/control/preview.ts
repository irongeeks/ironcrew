import express from "express";
import type { WebsiteWorkflow } from "../../packages/domain/workflows/website.ts";
/** Separate loopback origin. Untrusted assets never share the authenticated Control origin. */
export function createPreviewApp(sites: WebsiteWorkflow) {
  const preview = express();
  preview.disable("x-powered-by");
  preview.get("/:version/{*asset}", async (req, res) => {
    try {
      const relative = Array.isArray(req.params.asset) ? req.params.asset.join("/") : req.params.asset || "index.html";
      const asset = await sites.previewAsset(req.params.version, relative);
      res.set(previewSecurityHeaders(asset.mediaType, asset.allowScripts)).send(asset.content);
    } catch {
      res.status(404).end();
    }
  });
  return preview;
}

/** Shared by the HTTP preview and the isolated browser inspector. */
export function previewSecurityHeaders(mediaType: string, allowScripts: boolean): Record<string, string> {
  return {
    "Content-Type": mediaType,
    "Content-Security-Policy": `default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; script-src ${allowScripts ? "'self'" : "'none'"}; connect-src 'none'; font-src 'self'; form-action 'none'; base-uri 'none'; sandbox${allowScripts ? " allow-scripts" : ""}`,
    "Access-Control-Allow-Origin": "*",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
}
