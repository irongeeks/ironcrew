import { writeFile, readFile } from "node:fs/promises";
import { z } from "zod";
import { createApp } from "../apps/control/app.ts";
import type { Repository } from "../packages/persistence/src/index.ts";
import { workerMessageSchema, controlMessageSchema } from "../packages/contracts/src/index.ts";
import { remoteWorkerSchema, remoteControlSchema } from "../packages/tools/remote-execution/protocol.ts";
import { contracts } from "../apps/control/api-contracts/registry.ts";
import { error, object, text, id } from "../apps/control/api-contracts/common.ts";
export function routeInventory() {
  const app = createApp({ repo: {} as Repository, directory: ".var", publicOrigin: "http://127.0.0.1:8790" });
  const router = (
    app as unknown as { router: { stack: { route?: { path: string; methods: Record<string, boolean> } }[] } }
  ).router;
  return router.stack
    .flatMap(({ route }) =>
      !route || !route.path.startsWith("/api/v1")
        ? []
        : Object.keys(route.methods).map((method) => method + " " + route.path.replace(/:([A-Za-z]+)/g, "{$1}")),
    )
    .sort();
}
export function assertRouteCoverage() {
  const actual = routeInventory(),
    declared = contracts
      .filter((c) => !c.external)
      .map((c) => c.method + " " + c.path)
      .sort();
  const missing = actual.filter((key) => !declared.includes(key)),
    stale = declared.filter((key) => !actual.includes(key));
  if (missing.length || stale.length)
    throw new Error(`API contract coverage mismatch. Missing: ${missing.join(", ")}; stale: ${stale.join(", ")}`);
  return actual.length;
}
type SchemaObject = Record<string, unknown>;
export function generateOpenAPI() {
  assertRouteCoverage();
  const schemas: Record<string, unknown> = {};
  const schema = (name: string, value: z.ZodType, input = false) => {
    const converted = z.toJSONSchema(value, { io: input ? "input" : "output", cycles: "ref", reused: "inline" });
    // Each Zod conversion is a standalone JSON Schema. Rebase local recursive references when embedding it.
    const rebase = (node: unknown): unknown =>
      Array.isArray(node)
        ? node.map(rebase)
        : node && typeof node === "object"
          ? Object.fromEntries(
              Object.entries(node).map(([key, v]) => [
                key,
                key === "$ref" && typeof v === "string" && v.startsWith("#/")
                  ? "#/components/schemas/" + name + v.slice(1)
                  : rebase(v),
              ]),
            )
          : node;
    schemas[name] = rebase(converted);
    return { $ref: "#/components/schemas/" + name };
  };
  const standardError = schema("Error", error),
    webhookError = schema("WebhookError", z.union([object({ error: text }), error])),
    transferError = schema("TransferError", z.union([object({ error: object({ code: text }) }), error]));
  schema("WorkerMessage", workerMessageSchema);
  schema("ControlMessage", controlMessageSchema);
  schema("RemoteWorkerMessage", remoteWorkerSchema);
  schema("RemoteControlMessage", remoteControlSchema);
  const paths: Record<string, Record<string, unknown>> = {};
  for (const c of contracts) {
    const name = c.method + "_" + c.path.replace(/[^a-z0-9]/gi, "_"),
      mutation = c.method !== "get",
      security = c.security ?? "ceo",
      session = c.path === "/api/v1/session";
    const parameters: SchemaObject[] = [...c.path.matchAll(/\{([^}]+)\}/g)].map((m) => ({
      name: m[1],
      in: "path",
      required: true,
      schema: c.pathParameters?.[m[1]!]
        ? schema(name + "_path_" + m[1], c.pathParameters[m[1]!]!, true)
        : m[1] === "provider"
          ? { type: "string", enum: ["telegram", "discord", "email"] }
          : m[1] === "index"
            ? { type: "integer", minimum: 0, maximum: c.path.includes("/output/") ? 1025 : 1023 }
            : { type: "string", format: "uuid" },
    }));
    const header = (name: string, value: SchemaObject, required: boolean, description: string) =>
      parameters.push({ name, in: "header", required, schema: value, description });
    if (mutation && security === "ceo" && !session)
      header(
        "Idempotency-Key",
        { type: "string", minLength: 1, maxLength: 200 },
        true,
        "Exact method, path, JSON body and If-Match binding. Same key replays the saved result; changed binding is 409. One-time credential replays are 410.",
      );
    if (mutation && (security === "ceo" || security === "setup")) {
      header(
        "X-CSRF-Token",
        { type: "string" },
        security !== "setup",
        "Must match the authenticated CEO session. Setup uses it only after company creation.",
      );
      header(
        "Origin",
        { type: "string", format: "uri" },
        false,
        "If supplied for an authenticated mutation, must equal configured publicOrigin.",
      );
    }
    if (session && c.method === "post")
      header("Origin", { type: "string", format: "uri" }, false, "If supplied, must match configured publicOrigin.");
    if (security === "setup")
      header(
        "X-Setup-Token",
        { type: "string" },
        false,
        "Required before company initialization. Afterward CEO session authority applies instead.",
      );
    if (c.revision) {
      const pattern =
        c.revision === "quoted-positive"
          ? '^"?[1-9][0-9]*"?$'
          : c.revision === "nonnegative"
            ? "^(0|[1-9][0-9]*)$"
            : c.revision === "positive"
              ? "^[1-9][0-9]*$"
              : undefined;
      header(
        "If-Match",
        { type: "string", ...(pattern ? { pattern } : {}) },
        true,
        c.revision === "nonnegative"
          ? "Exact raw public revision; 0 initializes an absent channel configuration. Stale revisions conflict."
          : "Exact public resource revision. See runtime revision validation and error statuses.",
      );
    }
    if (c.pagination === "offset") {
      parameters.push(
        { name: "cursor", in: "query", schema: { type: "integer", minimum: 0, default: 0 } },
        {
          name: "limit",
          in: "query",
          schema: { type: "integer", minimum: 1, default: 100 },
          description: "Values above 100 are clamped to 100.",
        },
      );
      if (c.path === "/api/v1/orders") parameters.push({ name: "status", in: "query", schema: { type: "string" } });
    }
    if (c.pagination === "notifications")
      parameters.push(
        { name: "after", in: "query", schema: { type: "integer", minimum: 0, default: 0 } },
        { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
      );
    if (c.pagination === "sse") {
      parameters.push({ name: "after", in: "query", schema: { type: "integer", minimum: 0, default: 0 } });
      header(
        "Last-Event-ID",
        { type: "string", pattern: "^[0-9]+$" },
        false,
        "Persisted sequence cursor. Overrides after.",
      );
    }
    for (const [key, h] of Object.entries(c.headers ?? {}))
      header(key, z.toJSONSchema(h.schema), h.required ?? false, h.description);
    const media = c.media ?? "application/json";
    const responseHeaders = Object.fromEntries(
      Object.entries(c.responseHeaders ?? {}).map(([key, h]) => [
        key,
        { description: h.description, schema: z.toJSONSchema(h.schema) },
      ]),
    );
    if (!c.external)
      responseHeaders["X-Request-Id"] = { description: "Per-request correlation UUID.", schema: z.toJSONSchema(id) };
    const responses: Record<string, unknown> = {
      [c.status ?? 200]: {
        description: c.status === 204 ? "Verified stream persisted; no response body." : "Successful response.",
        headers: responseHeaders,
        ...(c.output
          ? {
              content: {
                [media]: {
                  schema:
                    media === "application/json"
                      ? schema(name + "Response", c.output)
                      : {
                          type: "string",
                          ...(media === "text/event-stream" ? { description: c.description } : { format: "binary" }),
                        },
                },
              },
            }
          : {}),
      },
    };
    const statuses = new Set<number>(c.errors ?? []);
    statuses.add(500);
    if (security === "ceo" || security === "setup") {
      statuses.add(401);
      statuses.add(403);
      statuses.add(409);
    }
    if (c.input || c.pagination || c.path.includes("{")) statuses.add(400);
    if (c.path.includes("{") && security !== "transfer") statuses.add(404);
    if (security === "transfer") statuses.add(423);
    if (mutation && security !== "transfer") {
      statuses.add(409);
      statuses.add(423);
    }
    if (c.revision === "quoted-positive") statuses.add(428);
    const descriptions: Record<number, string> = {
      400: "Invalid input/header/query schema.",
      401: "Authentication missing or invalid.",
      403: "Authority, origin, CSRF or scope denied.",
      404: "Scoped resource not found.",
      409: "Revision, idempotency, mandate, budget, state or evidence conflict.",
      410: "One-time credential already issued; it cannot be read again.",
      413: "Stream/manifest size limit.",
      423: "Maintenance write barrier active.",
      428: "Required positive public revision is missing or malformed.",
      429: "Login/setup rate limit exceeded.",
      500: "Internal processing failure.",
      503: "Configured provider, worker or storage unavailable.",
    };
    for (const status of [...statuses].sort())
      responses[status] = {
        description: descriptions[status] ?? "Request failed.",
        content:
          status === 429
            ? { "text/plain": { schema: { type: "string" }, example: "Too many requests, please try again later." } }
            : {
                "application/json": {
                  schema:
                    security === "webhook" ? webhookError : security === "transfer" ? transferError : standardError,
                },
              },
      };
    const operation = {
      operationId: name,
      tags: [
        c.source
          .split("/")
          .at(-1)!
          .replace(/(-routes)?\.ts$/, ""),
      ],
      description: c.description ?? "See the runtime source and shared validation schemas.",
      "x-runtime-source": c.source,
      security:
        security === "public"
          ? []
          : security === "ceo"
            ? [{ ceoSession: [] }]
            : security === "setup"
              ? [{ setupToken: [] }, { ceoSession: [] }]
              : security === "transfer"
                ? [{ transferTicket: [] }]
                : [
                    { telegramSecret: [] },
                    { discordSignature: [], discordTimestamp: [] },
                    { emailSignature: [], emailTimestamp: [] },
                  ],
      parameters,
      ...(c.input
        ? {
            requestBody: {
              required: !c.bodyOptional,
              content: {
                [security === "transfer" ? "application/octet-stream" : "application/json"]: {
                  schema:
                    security === "transfer"
                      ? { type: "string", format: "binary" }
                      : schema(name + "Request", c.input, true),
                },
              },
            },
          }
        : mutation
          ? {
              "x-request-body":
                "No semantic request body is consumed. Where Idempotency-Key is required, any ignored body still participates in its binding.",
            }
          : {}),
      responses,
    };
    (paths[c.path] ??= {})[c.method] = operation;
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "IronCrew Control API",
      version: "0.4.0-dev.0",
      description:
        "Explicit HTTP request/response contracts matched to mounted Express routes. Shared runtime Zod inputs preserve schema behavior. JSON Schema cannot encode stateful scope/CAS/approval guards, byte hash checks or all Zod refinements; those are tested at runtime and described per operation. Opaque JSON is limited to genuine extension payloads, tool results and event/step data.",
    },
    servers: [{ url: "/" }],
    paths,
    components: {
      securitySchemes: {
        ceoSession: { type: "apiKey", in: "cookie", name: "ironcrew_session" },
        setupToken: { type: "apiKey", in: "header", name: "X-Setup-Token" },
        transferTicket: {
          type: "http",
          scheme: "bearer",
          description: "TLS, direction/job/manifest/generation-bound short-lived worker transfer ticket.",
        },
        telegramSecret: { type: "apiKey", in: "header", name: "X-Telegram-Bot-Api-Secret-Token" },
        discordSignature: { type: "apiKey", in: "header", name: "X-Signature-Ed25519" },
        discordTimestamp: { type: "apiKey", in: "header", name: "X-Signature-Timestamp" },
        emailSignature: { type: "apiKey", in: "header", name: "X-IronCrew-Signature" },
        emailTimestamp: { type: "apiKey", in: "header", name: "X-IronCrew-Timestamp" },
      },
      schemas,
    },
    "x-websocket-protocols": {
      worker: {
        path: "/api/v1/workers/connect",
        transport: "wss",
        authentication: "Authorization: Bearer <enrollment token>, X-Worker-Id, X-Worker-Generation",
        messages: ["WorkerMessage", "ControlMessage", "RemoteWorkerMessage", "RemoteControlMessage"],
        description:
          "Separate HTTPS upgrade handler; not a JSON REST operation. Sequence/generation/lease fencing and attestation apply. Artifact bytes travel only through ticket-authenticated streaming endpoints.",
      },
    },
  };
}
if (process.argv[1]?.endsWith("scripts/openapi.ts")) {
  const serialized = JSON.stringify(generateOpenAPI(), null, 2) + "\n",
    target = "docs/openapi.json";
  if (process.argv.includes("--check")) {
    if ((await readFile(target, "utf8")) !== serialized) throw new Error("OpenAPI drift: run node scripts/openapi.ts");
    console.info(`OpenAPI synchronized: ${contracts.length} operations`);
  } else await writeFile(target, serialized);
}
