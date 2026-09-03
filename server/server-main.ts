import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import type { BaseRuntimeContext, RuntimeContext } from "./types/runtime-context.ts";
import { createAdapterRegistry } from "./adapters/index.ts";
import { PackLoader } from "./packs/pack-loader.ts";
import { PackRegistry } from "./packs/pack-registry.ts";
import { GraphRunner } from "./modules/workflow/orchestration/graph-runner.ts";
import { ConnectorRegistry } from "./connectors/registry.ts";
import { comfyuiConnector } from "./connectors/built-in/comfyui/connector.ts";
import { webSearchConnector } from "./connectors/built-in/web-search/connector.ts";
import { McpManager } from "./connectors/built-in/mcp/mcp-manager.ts";
import { loadNodeTypes } from "./node-types/node-type-loader.ts";

import { DIST_DIR, IS_PRODUCTION } from "./config/runtime.ts";
import {
  IN_PROGRESS_ORPHAN_GRACE_MS,
  IN_PROGRESS_ORPHAN_SWEEP_MS,
  SQLITE_BUSY_RETRY_BASE_DELAY_MS,
  SQLITE_BUSY_RETRY_JITTER_MS,
  SQLITE_BUSY_RETRY_MAX_ATTEMPTS,
  SQLITE_BUSY_RETRY_MAX_DELAY_MS,
  SUBTASK_DELEGATION_SWEEP_MS,
  initializeDatabaseRuntime,
} from "./db/runtime.ts";
import {
  installSecurityMiddleware,
  isIncomingMessageAuthenticated,
  isIncomingMessageOriginTrusted,
} from "./security/auth.ts";
import { assertRuntimeFunctionsResolved, createDeferredRuntimeProxy } from "./modules/deferred-runtime.ts";
import { ROUTE_RUNTIME_HELPER_KEYS } from "./modules/runtime-helper-keys.ts";
import { startLifecycle } from "./modules/lifecycle.ts";
import { registerApiRoutes } from "./modules/routes.ts";
import { createOAuthContext } from "./contexts/oauth-context.ts";
import { createMessagingContext } from "./contexts/messaging-context.ts";
import { createTaskExecutionContext } from "./contexts/task-execution-context.ts";
import { createDelegationContext } from "./contexts/delegation-context.ts";
import { createMeetingContext } from "./contexts/meeting-context.ts";
import { createReviewContext } from "./contexts/review-context.ts";
import { createProjectContext } from "./contexts/project-context.ts";
import { createUtilContext } from "./contexts/util-context.ts";
import { globalErrorHandler } from "./middleware/error-handler.ts";
import { initializeWorkflow } from "./modules/workflow.ts";
import {
  createReadSettingString,
  createRunInTransaction,
  firstQueryValue,
  nowMs,
  sleepMs,
} from "./modules/bootstrap/helpers.ts";
import {
  createMessageIdempotencyTools,
  IdempotencyConflictError,
  StorageBusyError,
} from "./modules/bootstrap/message-idempotency.ts";
import { createSecurityAuditTools } from "./modules/bootstrap/security-audit.ts";
import { applyBaseSchema } from "./modules/bootstrap/schema/base-schema.ts";
import { initializeOAuthRuntime } from "./modules/bootstrap/schema/oauth-runtime.ts";
import { runMigrations } from "./modules/bootstrap/migrations/runner.ts";
import { allMigrations } from "./modules/bootstrap/migrations/registry.ts";
import { applyDefaultSeeds } from "./modules/bootstrap/schema/seeds.ts";
import {
  attachSqliteDestination,
  createTracer,
  createMetricsCollector,
  createRequestTraceMiddleware,
  createOtlpExporter,
} from "./observability/index.ts";
import { logger } from "./observability/logger.ts";
import { assertOAuthEncryptionReady, getEncryptionSecretStatus } from "./oauth/helpers.ts";

export type { TaskCreationAuditInput } from "./modules/bootstrap/security-audit.ts";

const app = express();

const { dbPath, db, logsDir } = initializeDatabaseRuntime();

// Eager OAuth encryption secret guard: fails fast if existing credentials
// cannot be decrypted, warns loudly for fresh installs or legacy fallback.
{
  const countOAuthCredentials = (): number => {
    const row = db.prepare("SELECT COUNT(*) as c FROM oauth_credentials").get() as { c: number } | undefined;
    return row?.c ?? 0;
  };
  const { warnings } = assertOAuthEncryptionReady({ countOAuthCredentials });
  const isFallback = getEncryptionSecretStatus().status === "fallback";
  for (const msg of warnings) {
    if (isFallback) {
      // Deprecated SESSION_SECRET fallback — escalate so operators notice and migrate.
      logger.error({ module: "startup" }, msg);
    } else {
      logger.warn({ module: "startup" }, msg);
    }
  }
}

installSecurityMiddleware(app, db);
const distDir = DIST_DIR;
const isProduction = IS_PRODUCTION;

const runInTransaction = createRunInTransaction(db);
const readSettingString = createReadSettingString(db);

applyBaseSchema(db);
const oauthRuntime = initializeOAuthRuntime({ db, nowMs, runInTransaction });
runMigrations(db, allMigrations);
attachSqliteDestination(db);

const tracer = createTracer(db);
const metricsCollector = createMetricsCollector(db);

applyDefaultSeeds(db);

const messageIdempotency = createMessageIdempotencyTools({
  db,
  nowMs,
  sleepMs,
  SQLITE_BUSY_RETRY_BASE_DELAY_MS,
  SQLITE_BUSY_RETRY_JITTER_MS,
  SQLITE_BUSY_RETRY_MAX_ATTEMPTS,
  SQLITE_BUSY_RETRY_MAX_DELAY_MS,
});

const securityAudit = createSecurityAuditTools({
  db,
  logsDir,
  nowMs,
  withSqliteBusyRetry: messageIdempotency.withSqliteBusyRetry,
});

const adapterRegistry = createAdapterRegistry();

// ── Pack system initialization ──
const connectorRegistry = new ConnectorRegistry();

// Register built-in connectors
connectorRegistry.registerConnector(comfyuiConnector);
connectorRegistry.registerConnector(webSearchConnector);

// Load saved connector bindings from settings, then auto-bind ComfyUI if not already bound
{
  const savedBindings = readSettingString("connector_capability_bindings");
  if (savedBindings) {
    try {
      const bindingsMap = JSON.parse(savedBindings) as Record<
        string,
        { connector: string; timeout_ms?: number; max_retries?: number; connector_config?: Record<string, unknown> }
      >;
      for (const [capability, config] of Object.entries(bindingsMap)) {
        if (config && typeof config.connector === "string") {
          connectorRegistry.setBinding(capability, {
            connector: config.connector,
            timeout_ms: config.timeout_ms,
            max_retries: config.max_retries,
            connector_config: config.connector_config ?? {},
          });
        }
      }
    } catch {
      // best-effort
    }
  }

  // Auto-bind ComfyUI capabilities from comfyui_server_url setting if no explicit bindings exist
  const comfyUrl = readSettingString("comfyui_server_url");
  if (comfyUrl) {
    const comfyConfig = { serverUrl: comfyUrl };
    if (!connectorRegistry.getAgentGuidance("text2img", "en")) {
      connectorRegistry.setBinding("text2img", { connector: "comfyui", connector_config: comfyConfig });
    }
    if (!connectorRegistry.getAgentGuidance("img2video", "en")) {
      connectorRegistry.setBinding("img2video", { connector: "comfyui", connector_config: comfyConfig });
    }
    if (!connectorRegistry.getAgentGuidance("text2speech", "en")) {
      connectorRegistry.setBinding("text2speech", { connector: "comfyui", connector_config: comfyConfig });
    }
  }
}

// ── MCP server connections ──
const mcpManager = new McpManager();
mcpManager.loadFromSettings(db);
await mcpManager.connectAll();
mcpManager.registerAll(connectorRegistry);

const packLoader = new PackLoader();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packs = await packLoader.loadAll(path.join(__dirname, "packs/built-in"), path.join(__dirname, "packs/community"));
const packRegistry = new PackRegistry();
packRegistry.load(packs);

// ── Node type system initialization ──
const __nodeTypesDir = path.join(__dirname, "node-types");
const nodeTypeRegistry = await loadNodeTypes(
  path.join(__nodeTypesDir, "built-in"),
  path.join(__nodeTypesDir, "community"),
);

const graphRunner = new GraphRunner(connectorRegistry, tracer, metricsCollector, nodeTypeRegistry);

app.use(createRequestTraceMiddleware(metricsCollector));

const runtimeContext: Record<string, any> & BaseRuntimeContext = {
  app,
  db,
  dbPath,
  logsDir,
  distDir,
  isProduction,
  nowMs,
  runInTransaction,
  firstQueryValue,
  readSettingString,
  adapterRegistry,
  tracer,
  metrics: metricsCollector,

  connectorRegistry,
  mcpManager,
  packLoader,
  packRegistry,
  graphRunner,
  nodeTypeRegistry,

  IN_PROGRESS_ORPHAN_GRACE_MS,
  IN_PROGRESS_ORPHAN_SWEEP_MS,
  SUBTASK_DELEGATION_SWEEP_MS,

  ensureOAuthActiveAccount: oauthRuntime.ensureOAuthActiveAccount,
  getActiveOAuthAccountIds: oauthRuntime.getActiveOAuthAccountIds,
  setActiveOAuthAccount: oauthRuntime.setActiveOAuthAccount,
  setOAuthActiveAccounts: oauthRuntime.setOAuthActiveAccounts,
  removeActiveOAuthAccount: oauthRuntime.removeActiveOAuthAccount,
  oauthProviderPrefix: oauthRuntime.oauthProviderPrefix,
  normalizeOAuthProvider: oauthRuntime.normalizeOAuthProvider,
  getNextOAuthLabel: oauthRuntime.getNextOAuthLabel,
  isIncomingMessageAuthenticated,
  isIncomingMessageOriginTrusted,

  IdempotencyConflictError,
  StorageBusyError,
  insertMessageWithIdempotency: messageIdempotency.insertMessageWithIdempotency,
  resolveMessageIdempotencyKey: messageIdempotency.resolveMessageIdempotencyKey,
  withSqliteBusyRetry: messageIdempotency.withSqliteBusyRetry,
  recordMessageIngressAuditOr503: securityAudit.recordMessageIngressAuditOr503,
  recordAcceptedIngressAuditOrRollback: securityAudit.recordAcceptedIngressAuditOrRollback,
  recordTaskCreationAudit: securityAudit.recordTaskCreationAudit,
  setTaskCreationAuditCompletion: securityAudit.setTaskCreationAuditCompletion,

  WebSocket,
  WebSocketServer,
  express,

  DEPT_KEYWORDS: {},
};

const runtimeProxy = createDeferredRuntimeProxy(runtimeContext);

const oauthCtx = createOAuthContext({
  db,
  nowMs,
  ensureOAuthActiveAccount: oauthRuntime.ensureOAuthActiveAccount,
  getActiveOAuthAccountIds: oauthRuntime.getActiveOAuthAccountIds,
  setActiveOAuthAccount: oauthRuntime.setActiveOAuthAccount,
  setOAuthActiveAccounts: oauthRuntime.setOAuthActiveAccounts,
  removeActiveOAuthAccount: oauthRuntime.removeActiveOAuthAccount,
});
Object.assign(runtimeContext, oauthCtx);

Object.assign(runtimeContext, initializeWorkflow(runtimeProxy as RuntimeContext));
graphRunner.setBroadcast((runtimeContext as unknown as { broadcast: (e: string, p: unknown) => void }).broadcast);
Object.assign(runtimeContext, registerApiRoutes(runtimeContext as RuntimeContext, oauthCtx));
app.use(globalErrorHandler);

// ── Phase 3 domain context factories (transitional pass-through wrappers) ──
// These extract typed domain slices from the fully-wired runtimeContext.
// Created AFTER initializeWorkflow + registerApiRoutes so all functions exist.
const rc = runtimeContext as unknown as RuntimeContext;
const messagingCtx = createMessagingContext(rc);
const taskExecutionCtx = createTaskExecutionContext(rc);
const delegationCtx = createDelegationContext(rc);
const meetingCtx = createMeetingContext(rc);
const reviewCtx = createReviewContext(rc);
const projectCtx = createProjectContext(rc);
const utilCtx = createUtilContext(rc);
Object.assign(
  runtimeContext,
  messagingCtx,
  taskExecutionCtx,
  delegationCtx,
  meetingCtx,
  reviewCtx,
  projectCtx,
  utilCtx,
);

assertRuntimeFunctionsResolved(runtimeContext, ROUTE_RUNTIME_HELPER_KEYS, "route helper wiring");

startLifecycle(runtimeContext as RuntimeContext);

// Observability runtime config: env vars take precedence over DB settings.
// readObsConfig() merges defaults ← DB (observability_config) ← env vars.
function readObsConfig(): {
  otlpEnabled: boolean;
  otlpEndpoint: string;
  otlpIntervalMs: number;
  otlpHeaders?: Record<string, string>;
  logRetentionDays: number;
  metricsRetentionDays: number;
  traceRetentionDays: number;
  aggregateRetentionDays: number;
  maxLogRows: number;
} {
  // Defaults
  const defaults = {
    otlpEnabled: false,
    otlpEndpoint: "http://localhost:4318",
    otlpIntervalMs: 30_000,
    logRetentionDays: 7,
    metricsRetentionDays: 7,
    traceRetentionDays: 30,
    aggregateRetentionDays: 90,
    maxLogRows: 500_000,
  };

  // DB settings (lowest priority after defaults)
  let dbConfig: Record<string, unknown> = {};
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'observability_config' LIMIT 1").get() as
      | { value: string }
      | undefined;
    if (row) dbConfig = JSON.parse(row.value);
  } catch {
    /* no config yet */
  }

  // Env vars (highest priority)
  return {
    otlpEnabled:
      process.env.OTLP_ENABLED !== undefined
        ? process.env.OTLP_ENABLED === "true"
        : ((dbConfig.otlp_enabled as boolean) ?? defaults.otlpEnabled),
    otlpEndpoint: process.env.OTLP_ENDPOINT || (dbConfig.otlp_endpoint as string) || defaults.otlpEndpoint,
    otlpIntervalMs: process.env.OTLP_EXPORT_INTERVAL_MS
      ? Number(process.env.OTLP_EXPORT_INTERVAL_MS)
      : (dbConfig.otlp_export_interval_ms as number) || defaults.otlpIntervalMs,
    otlpHeaders: process.env.OTLP_HEADERS
      ? Object.fromEntries(
          process.env.OTLP_HEADERS.split(",").map((h) => h.split("=").map((s) => s.trim()) as [string, string]),
        )
      : undefined,
    logRetentionDays: (dbConfig.log_retention_days as number) || defaults.logRetentionDays,
    metricsRetentionDays: (dbConfig.metrics_retention_days as number) || defaults.metricsRetentionDays,
    traceRetentionDays: (dbConfig.trace_retention_days as number) || defaults.traceRetentionDays,
    aggregateRetentionDays: (dbConfig.metrics_aggregate_retention_days as number) || defaults.aggregateRetentionDays,
    maxLogRows: (dbConfig.max_log_rows as number) || defaults.maxLogRows,
  };
}

const obsConfig = readObsConfig();
if (obsConfig.otlpEnabled) {
  const otlpExporter = createOtlpExporter(db, {
    endpoint: obsConfig.otlpEndpoint,
    intervalMs: obsConfig.otlpIntervalMs,
    headers: obsConfig.otlpHeaders,
  });
  otlpExporter.start();
}
