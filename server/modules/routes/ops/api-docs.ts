import fs from "node:fs";
import path from "node:path";
import type { Express, RequestHandler } from "express";
import swaggerUi from "swagger-ui-express";

type OpenApiDocument = Record<string, unknown>;

const OPENAPI_PATH = path.resolve(process.cwd(), "docs", "openapi.json");

let cachedOpenApiDoc: OpenApiDocument | null = null;
let cachedOpenApiMtimeMs = 0;

function loadOpenApiDoc(): OpenApiDocument {
  const stat = fs.statSync(OPENAPI_PATH);
  if (cachedOpenApiDoc && stat.mtimeMs === cachedOpenApiMtimeMs) {
    return cachedOpenApiDoc;
  }

  const raw = fs.readFileSync(OPENAPI_PATH, "utf8");
  const parsed = JSON.parse(raw) as OpenApiDocument;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("openapi_spec_invalid");
  }

  cachedOpenApiDoc = parsed;
  cachedOpenApiMtimeMs = stat.mtimeMs;
  return cachedOpenApiDoc;
}

export function registerApiDocsRoutes({ app }: { app: Express }): void {
  app.get("/api/docs/swagger-bootstrap.js", (_req, res) => {
    return res.type("application/javascript").send(`
window.addEventListener("load", () => {
  fetch("/api/auth/session", { credentials: "same-origin" }).catch(() => {});
});
`);
  });

  const renderSwaggerUi: RequestHandler = (req, res, next) => {
    try {
      const setup = swaggerUi.setup(loadOpenApiDoc(), {
        explorer: true,
        customSiteTitle: "OctoOffice API Docs",
        customJs: "/api/docs/swagger-bootstrap.js",
        swaggerOptions: {
          persistAuthorization: true,
          requestInterceptor: (request: Record<string, unknown>) => {
            request.credentials = "same-origin";
            return request;
          },
        },
      });
      return setup(req, res, next);
    } catch (error) {
      return res.status(500).json({
        error: "openapi_spec_load_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  app.get("/api/openapi.json", (_req, res) => {
    try {
      return res.json(loadOpenApiDoc());
    } catch (error) {
      return res.status(500).json({
        error: "openapi_spec_load_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.use("/api/docs", swaggerUi.serve, renderSwaggerUi);
}
