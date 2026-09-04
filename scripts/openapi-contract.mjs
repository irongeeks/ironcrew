#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import SwaggerParser from "@apidevtools/swagger-parser";
import prettier from "prettier";

const OPENAPI_PATH = path.resolve(process.cwd(), "docs", "openapi.json");
const ROUTES_DIR = path.resolve(process.cwd(), "server", "modules", "routes");
const MODE = process.argv.includes("--write") ? "write" : "check";
const STRICT = process.argv.includes("--strict");

const METHODS = ["get", "post", "put", "patch", "delete"];
const PUBLIC_API_PATHS = new Set(["/api/health", "/api/auth/session", "/api/openapi.json"]);
const MUTATING_METHODS = new Set(["post", "put", "patch", "delete"]);
const JSON_MEDIA_TYPES = ["application/json"];

const STANDARD_ERROR_RESPONSE_REFS = {
  401: "#/components/responses/UnauthorizedError",
  403: "#/components/responses/ForbiddenError",
  409: "#/components/responses/ConflictError",
  429: "#/components/responses/TooManyRequestsError",
  500: "#/components/responses/InternalServerError",
};

const REQUEST_EXAMPLE_OVERRIDES = {
  "POST /api/departments": {
    id: "planning2",
    name: "Planning II",
    icon: "🧭",
    color: "#6b7280",
  },
  "POST /api/agents": {
    name: "Alex",
    department_id: "planning",
    role: "team_leader",
    cli_provider: "claude",
  },
  "POST /api/tasks": {
    title: "Fix CI OpenAPI contract check",
    description: "Add OpenAPI validation and sync gate in CI",
    priority: 2,
    status: "inbox",
    task_type: "general",
  },
  "PATCH /api/tasks/{id}": {
    status: "in_progress",
    priority: 3,
  },
  "POST /api/tasks/{id}/run": {
    agent_id: "agent_001",
  },
  "POST /api/tasks/{id}/stop": {
    mode: "cancel",
  },
  "POST /api/messages": {
    sender_type: "ceo",
    receiver_type: "agent",
    receiver_id: "agent_001",
    message_type: "chat",
    content: "Please start implementation.",
  },
  "POST /api/inbox": {
    source: "telegram",
    text: "$Fix build failure on main",
    author: "CEO",
    project_id: "project_001",
    project_path: "/workspace/my-project",
    project_context: "Stabilize release pipeline",
  },
  "PUT /api/settings": {
    ceoName: "CEO",
    language: "ko",
  },
  "POST /api/projects": {
    name: "my-project",
    project_path: "/workspace/my-project",
    core_goal: "Ship MVP with CI stabilization",
  },
  "POST /api/decision-inbox/{id}/reply": {
    option_number: 1,
    note: "Proceed with this option.",
  },
};

const RESPONSE_EXAMPLE_OVERRIDES = {
  "GET /api/health 200": {
    ok: true,
    status: "healthy",
  },
  "GET /api/auth/session 200": {
    ok: true,
  },
  "GET /api/tasks 200": {
    tasks: [
      {
        id: "task_001",
        title: "Fix build",
        status: "inbox",
      },
    ],
  },
  "POST /api/tasks 200": {
    id: "task_001",
    task: {
      id: "task_001",
      title: "Fix CI OpenAPI contract check",
      status: "inbox",
    },
  },
  "POST /api/inbox 200": {
    ok: true,
    id: "msg_001",
    directive: true,
  },
  "GET /api/openapi.json 200": {
    openapi: "3.0.3",
    info: {
      title: "IronCrew API",
    },
  },
};

function normalizeNullableType(schema) {
  if (!schema || typeof schema !== "object") return;
  if (!Array.isArray(schema.type)) return;

  const uniqueTypes = [...new Set(schema.type.filter((item) => typeof item === "string"))];
  if (!uniqueTypes.includes("null")) return;

  const concreteTypes = uniqueTypes.filter((item) => item !== "null");
  if (concreteTypes.length === 1) {
    schema.type = concreteTypes[0];
    schema.nullable = true;
    return;
  }

  if (concreteTypes.length > 1) {
    schema.oneOf = concreteTypes.map((type) => ({ type }));
    delete schema.type;
    schema.nullable = true;
  }
}

function walkSchemaTree(schema, visitor) {
  if (!schema || typeof schema !== "object") return;
  visitor(schema);

  if (schema.properties && typeof schema.properties === "object") {
    for (const value of Object.values(schema.properties)) {
      walkSchemaTree(value, visitor);
    }
  }

  if (schema.items && typeof schema.items === "object") {
    walkSchemaTree(schema.items, visitor);
  }

  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    walkSchemaTree(schema.additionalProperties, visitor);
  }

  for (const key of ["oneOf", "allOf", "anyOf"]) {
    if (!Array.isArray(schema[key])) continue;
    for (const child of schema[key]) {
      walkSchemaTree(child, visitor);
    }
  }
}

function normalizeNullableTypes(doc) {
  if (doc.components?.schemas && typeof doc.components.schemas === "object") {
    for (const schema of Object.values(doc.components.schemas)) {
      walkSchemaTree(schema, normalizeNullableType);
    }
  }

  for (const pathItem of Object.values(doc.paths ?? {})) {
    if (!pathItem || typeof pathItem !== "object") continue;
    for (const method of METHODS) {
      const operation = pathItem[method];
      if (!operation || typeof operation !== "object") continue;

      const requestBodyContent = operation.requestBody?.content;
      if (requestBodyContent && typeof requestBodyContent === "object") {
        for (const media of Object.values(requestBodyContent)) {
          if (media?.schema && typeof media.schema === "object") {
            walkSchemaTree(media.schema, normalizeNullableType);
          }
        }
      }

      for (const response of Object.values(operation.responses ?? {})) {
        if (!response || typeof response !== "object" || !response.content) continue;
        for (const media of Object.values(response.content)) {
          if (media?.schema && typeof media.schema === "object") {
            walkSchemaTree(media.schema, normalizeNullableType);
          }
        }
      }
    }
  }
}

function exitWithError(message) {
  console.error(`[openapi] ${message}`);
  process.exit(1);
}

function loadOpenApiFile() {
  if (!fs.existsSync(OPENAPI_PATH)) {
    exitWithError(`OpenAPI file not found: ${OPENAPI_PATH}`);
  }
  const raw = fs.readFileSync(OPENAPI_PATH, "utf8");
  try {
    const doc = JSON.parse(raw);
    return { raw, doc };
  } catch (error) {
    exitWithError(
      `Invalid JSON in ${path.relative(process.cwd(), OPENAPI_PATH)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function serializeDoc(doc) {
  const json = JSON.stringify(doc, null, 2);
  const prettierConfig = (await prettier.resolveConfig(OPENAPI_PATH)) ?? {};
  return prettier.format(json, {
    ...prettierConfig,
    filepath: OPENAPI_PATH,
  });
}

function inferStringExample(name = "") {
  const lower = name.toLowerCase();
  if (lower === "id" || lower.endsWith("_id")) return "string_id";
  if (lower.includes("path")) return "/workspace/project";
  if (lower.includes("url")) return "https://example.com";
  if (lower.includes("status")) return "ok";
  if (lower.includes("name")) return "string";
  if (lower.includes("title")) return "string";
  if (lower.includes("description")) return "string";
  if (lower.includes("content")) return "string";
  if (lower.includes("message")) return "string";
  if (lower.includes("created") || lower.includes("updated")) return "2026-02-26T00:00:00.000Z";
  return "string";
}

function resolveSchemaRef(schema, doc, seenRefs) {
  if (!schema || typeof schema !== "object" || typeof schema.$ref !== "string") return schema;
  const ref = schema.$ref;
  if (!ref.startsWith("#/")) return null;
  if (seenRefs.has(ref)) return null;
  seenRefs.add(ref);
  const parts = ref.slice(2).split("/");
  let current = doc;
  for (const part of parts) {
    if (!current || typeof current !== "object") return null;
    current = current[part];
  }
  return current && typeof current === "object" ? current : null;
}

function inferExampleFromSchema(schema, doc, propertyName = "", seenRefs = new Set(), depth = 0) {
  if (!schema || typeof schema !== "object") return null;
  if (depth > 5) return null;

  if (schema.example !== undefined) return schema.example;

  if (schema.$ref) {
    const resolved = resolveSchemaRef(schema, doc, seenRefs);
    if (!resolved) return null;
    return inferExampleFromSchema(resolved, doc, propertyName, seenRefs, depth + 1);
  }

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum[0];
  }

  if (Array.isArray(schema.type)) {
    const concrete = schema.type.find((item) => item !== "null") ?? schema.type[0];
    return inferExampleFromSchema({ ...schema, type: concrete }, doc, propertyName, seenRefs, depth + 1);
  }

  switch (schema.type) {
    case "string": {
      if (schema.format === "date-time") return "2026-02-26T00:00:00.000Z";
      if (schema.format === "date") return "2026-02-26";
      if (schema.format === "uri") return "https://example.com";
      return inferStringExample(propertyName);
    }
    case "integer":
      return 1;
    case "number":
      return 1;
    case "boolean":
      return true;
    case "array": {
      const itemExample = inferExampleFromSchema(schema.items, doc, propertyName, seenRefs, depth + 1);
      return itemExample === null ? [] : [itemExample];
    }
    case "object": {
      const properties = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
      const required = Array.isArray(schema.required) ? new Set(schema.required) : new Set(Object.keys(properties));
      const out = {};
      for (const [key, value] of Object.entries(properties)) {
        if (!required.has(key) && required.size > 0) continue;
        const valueExample = inferExampleFromSchema(value, doc, key, seenRefs, depth + 1);
        if (valueExample !== null) out[key] = valueExample;
      }
      if (Object.keys(out).length > 0) return out;
      if (schema.additionalProperties) return { additionalProp1: "value" };
      return {};
    }
    default:
      return null;
  }
}

function ensureErrorResponseSchema(doc) {
  doc.components ??= {};
  doc.components.schemas ??= {};
  doc.components.schemas.ErrorResponse ??= {
    type: "object",
    properties: {
      error: { type: "string" },
      message: { type: "string" },
    },
    required: ["error"],
    additionalProperties: true,
  };
}

function ensureStandardErrorResponses(doc) {
  doc.components ??= {};
  doc.components.responses ??= {};

  const addResponse = (name, description, errorCode, message) => {
    doc.components.responses[name] ??= {
      description,
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ErrorResponse" },
          example: {
            error: errorCode,
            message,
          },
        },
      },
    };
  };

  addResponse("UnauthorizedError", "Unauthorized", "unauthorized", "Authentication is required.");
  addResponse("ForbiddenError", "Forbidden", "forbidden", "You do not have permission to access this resource.");
  addResponse("ConflictError", "Conflict", "conflict", "The request conflicts with current server state.");
  addResponse("TooManyRequestsError", "Too Many Requests", "too_many_requests", "Rate limit exceeded.");
  addResponse("InternalServerError", "Internal Server Error", "internal_error", "Unexpected server error.");
}

function isProtectedOperation(pathname, method, operation, doc) {
  if (!pathname.startsWith("/api/")) return false;
  if (PUBLIC_API_PATHS.has(pathname)) return false;
  if (pathname === "/api/docs" || pathname.startsWith("/api/docs/")) return false;
  if (Array.isArray(operation.security)) return operation.security.length > 0;
  if (Array.isArray(doc.security)) return doc.security.length > 0;
  return true;
}

function ensureOperationSecurity(pathname, operation) {
  if (pathname === "/api/inbox") {
    if (!Array.isArray(operation.security) || operation.security.length === 0) {
      operation.security = [{ inboxSecret: [] }];
    }
    return;
  }
  if (!Array.isArray(operation.security)) {
    operation.security = [{ bearerAuth: [] }];
  }
}

function ensureOperationErrorResponses(pathname, method, operation, doc) {
  operation.responses ??= {};
  const needsSecurity = isProtectedOperation(pathname, method, operation, doc);
  if (needsSecurity) {
    for (const statusCode of ["401", "403", "429", "500"]) {
      if (!operation.responses[statusCode]) {
        operation.responses[statusCode] = { $ref: STANDARD_ERROR_RESPONSE_REFS[statusCode] };
      }
    }
  }
  if (MUTATING_METHODS.has(method) && !operation.responses["409"]) {
    operation.responses["409"] = { $ref: STANDARD_ERROR_RESPONSE_REFS["409"] };
  }
}

function ensureRequestExamples(pathname, method, operation, doc) {
  if (!operation.requestBody || typeof operation.requestBody !== "object") return;
  const content = operation.requestBody.content;
  if (!content || typeof content !== "object") return;

  const overrideKey = `${method.toUpperCase()} ${pathname}`;
  for (const mediaType of JSON_MEDIA_TYPES) {
    const media = content[mediaType];
    if (!media || typeof media !== "object") continue;
    if (media.example !== undefined || media.examples !== undefined) continue;
    if (REQUEST_EXAMPLE_OVERRIDES[overrideKey]) {
      media.example = REQUEST_EXAMPLE_OVERRIDES[overrideKey];
      continue;
    }
    const inferred = inferExampleFromSchema(media.schema, doc);
    if (inferred !== null) media.example = inferred;
  }
}

function ensureResponseExamples(pathname, method, operation, doc) {
  operation.responses ??= {};
  for (const [statusCode, response] of Object.entries(operation.responses)) {
    if (!response || typeof response !== "object") continue;
    if (response.$ref) continue;

    if (!response.content && /^2\d\d$/.test(statusCode)) {
      const overrideKey = `${method.toUpperCase()} ${pathname} ${statusCode}`;
      response.content = {
        "application/json": {
          schema: {
            type: "object",
            additionalProperties: true,
          },
          example: RESPONSE_EXAMPLE_OVERRIDES[overrideKey] ?? { ok: true },
        },
      };
    }

    const content = response.content;
    if (!content || typeof content !== "object") continue;

    for (const mediaType of JSON_MEDIA_TYPES) {
      const media = content[mediaType];
      if (!media || typeof media !== "object") continue;
      if (media.example !== undefined || media.examples !== undefined) continue;

      const overrideKey = `${method.toUpperCase()} ${pathname} ${statusCode}`;
      if (RESPONSE_EXAMPLE_OVERRIDES[overrideKey]) {
        media.example = RESPONSE_EXAMPLE_OVERRIDES[overrideKey];
        continue;
      }

      const inferred = inferExampleFromSchema(media.schema, doc);
      if (inferred !== null) {
        media.example = inferred;
      } else if (/^2\d\d$/.test(statusCode)) {
        media.example = { ok: true };
      }
    }
  }
}

function normalizeOpenApiDoc(doc) {
  normalizeNullableTypes(doc);
  ensureErrorResponseSchema(doc);
  ensureStandardErrorResponses(doc);
  doc.paths ??= {};

  for (const [pathname, pathItem] of Object.entries(doc.paths)) {
    if (!pathItem || typeof pathItem !== "object") continue;
    for (const method of METHODS) {
      const operation = pathItem[method];
      if (!operation || typeof operation !== "object") continue;
      if (isProtectedOperation(pathname, method, operation, doc)) {
        ensureOperationSecurity(pathname, operation);
      }
      ensureOperationErrorResponses(pathname, method, operation, doc);
      ensureRequestExamples(pathname, method, operation, doc);
      ensureResponseExamples(pathname, method, operation, doc);
    }
  }
}

async function validateOpenApi(doc) {
  try {
    await SwaggerParser.validate(doc);
  } catch (error) {
    exitWithError(`OpenAPI validation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ---------------------------------------------------------------------------
// Bidirectional contract drift check
// ---------------------------------------------------------------------------
// Statically scans the route files for `.get("/x") / .post("/x") / …` calls
// and compares the (method, path) set against the paths declared in
// docs/openapi.json. This is a static regex scan — it will miss routes that
// are registered via variables or templates. Acceptable tradeoff for a
// check script.
//
// Path normalisation: Express `:id` → OpenAPI `{id}`.
// Both sets are prefix-stripped to their tail segments because route files
// use relative paths (e.g. `.get("/tasks")`) while OpenAPI declares absolute
// paths (e.g. `/api/core/tasks`). This produces occasional false-positives
// that are documented in the drift report header.

const ROUTE_CALL_RE = /\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g;

function listRouteFilesSync(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".ts")) continue;
      if (entry.name.endsWith(".test.ts")) continue;
      out.push(full);
    }
  }
  return out;
}

function expressToOpenApiPath(p) {
  return p.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

function tailSegment(p) {
  // Strip leading slashes and "api" prefix tokens so that
  // `/api/core/tasks/{id}` and `/tasks/{id}` both match.
  const cleaned = p.replace(/^\/+/, "");
  const parts = cleaned.split("/").filter(Boolean);
  while (
    parts.length > 0 &&
    (parts[0] === "api" || parts[0] === "core" || parts[0] === "ops" || parts[0] === "collab" || parts[0] === "docs")
  ) {
    parts.shift();
  }
  return "/" + parts.join("/");
}

function scanCodeRoutes() {
  const files = listRouteFilesSync(ROUTES_DIR);
  const pairs = new Set();
  const byPair = new Map();
  for (const file of files) {
    let content;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    ROUTE_CALL_RE.lastIndex = 0;
    let match;
    while ((match = ROUTE_CALL_RE.exec(content)) !== null) {
      const method = match[1].toUpperCase();
      const rawPath = match[2];
      // Skip non-route strings (e.g. `.get("content-type")` on a header object)
      if (!rawPath.startsWith("/")) continue;
      const normalised = expressToOpenApiPath(rawPath);
      const key = `${method} ${tailSegment(normalised)}`;
      pairs.add(key);
      if (!byPair.has(key)) byPair.set(key, []);
      byPair.get(key).push({ file: path.relative(process.cwd(), file), rawPath });
    }
  }
  return { pairs, byPair };
}

function openApiRoutePairs(doc) {
  const pairs = new Set();
  for (const [pathname, pathItem] of Object.entries(doc.paths ?? {})) {
    if (!pathItem || typeof pathItem !== "object") continue;
    for (const method of METHODS) {
      if (!pathItem[method]) continue;
      const key = `${method.toUpperCase()} ${tailSegment(pathname)}`;
      pairs.add(key);
    }
  }
  return pairs;
}

function reportContractDrift(doc) {
  const { pairs: codePairs } = scanCodeRoutes();
  const specPairs = openApiRoutePairs(doc);

  const missingInSpec = [...codePairs].filter((p) => !specPairs.has(p)).sort();
  const missingInCode = [...specPairs].filter((p) => !codePairs.has(p)).sort();

  const hasDrift = missingInSpec.length > 0 || missingInCode.length > 0;
  if (!hasDrift) {
    console.log("[openapi] bidirectional drift check: no drift (code ↔ spec in sync)");
    return { hasDrift: false, missingInSpec, missingInCode };
  }

  console.log(
    `[openapi] bidirectional drift check: ${missingInSpec.length} in code but missing from spec, ` +
      `${missingInCode.length} in spec but missing from code`,
  );
  console.log(
    "[openapi]   (paths compared after stripping /api /core /ops /collab /docs prefixes; some false positives expected from static scan)",
  );
  if (missingInSpec.length > 0) {
    console.log("[openapi] Missing from OpenAPI (in code, not spec):");
    for (const p of missingInSpec.slice(0, 50)) console.log(`  - ${p}`);
    if (missingInSpec.length > 50) console.log(`  … and ${missingInSpec.length - 50} more`);
  }
  if (missingInCode.length > 0) {
    console.log("[openapi] Missing from code (in spec, not code):");
    for (const p of missingInCode) console.log(`  - ${p}`);
  }
  return { hasDrift: true, missingInSpec, missingInCode };
}

function reportSummary(doc) {
  let operationCount = 0;
  for (const pathItem of Object.values(doc.paths ?? {})) {
    if (!pathItem || typeof pathItem !== "object") continue;
    for (const method of METHODS) {
      if (pathItem[method]) operationCount += 1;
    }
  }
  console.log(`[openapi] validated ${operationCount} operations`);
}

async function main() {
  const { raw, doc } = loadOpenApiFile();
  normalizeOpenApiDoc(doc);
  await validateOpenApi(doc);

  const next = await serializeDoc(doc);
  if (MODE === "write") {
    fs.writeFileSync(OPENAPI_PATH, next, "utf8");
    reportSummary(doc);
    reportContractDrift(doc);
    console.log(`[openapi] synced ${path.relative(process.cwd(), OPENAPI_PATH)}`);
    return;
  }

  const current = raw.endsWith("\n") ? raw : `${raw}\n`;
  if (current !== next) {
    exitWithError("OpenAPI contract is out of sync. Run `pnpm run openapi:sync` and commit the updated spec.");
  }
  reportSummary(doc);

  const drift = reportContractDrift(doc);
  if (drift.hasDrift && STRICT) {
    exitWithError(
      "Bidirectional drift detected between code and OpenAPI spec. Rerun without --strict or sync the spec.",
    );
  }

  console.log("[openapi] check passed");
}

await main();
