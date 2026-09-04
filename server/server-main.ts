import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import type { BaseRuntimeContext, RuntimeContext } from "./types/runtime-context.ts";
import { createAdapterRegistry, isCliAdapter } from "./adapters/index.ts";
import { PackLoader } from "./packs/pack-loader.ts";
import { PackRegistry } from "./packs/pack-registry.ts";
import { GraphRunner } from "./modules/workflow/orchestration/graph-runner.ts";
import { ConnectorRegistry } from "./connectors/registry.ts";
import { comfyuiConnector } from "./connectors/built-in/comfyui/connector.ts";
import { webSearchConnector } from "./connectors/built-in/web-search/connector.ts";
import { McpManager } from "./connectors/built-in/mcp/mcp-manager.ts";
import { McpConnector } from "./connectors/built-in/mcp/mcp-connector.ts";
import { configHasSecretRefs } from "./connectors/built-in/mcp/mcp-secrets.ts";
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
import { registerIronCrewRoutes } from "./ironcrew/api/routes.ts";
import { setCrewSessionResolver } from "./security/auth.ts";
import { ProxmoxAdapter } from "./ironcrew/packs/integrations/proxmox.ts";
import { TacticalRmmAdapter } from "./ironcrew/packs/integrations/tactical-rmm.ts";
import { UnifiAdapter } from "./ironcrew/packs/integrations/unifi.ts";
import { LexwareOfficeAdapter } from "./ironcrew/packs/integrations/lexware-office.ts";
import { AuditShipper, FileAuditSink, HttpAuditSink } from "./ironcrew/audit/audit-shipper.ts";
import { OidcProvider, OIDC_PROVISIONING_MODES, type OidcProvisioningMode } from "./ironcrew/auth/oidc-provider.ts";
import { SevdeskAdapter } from "./ironcrew/packs/integrations/sevdesk.ts";
import { PaperlessAdapter } from "./ironcrew/packs/integrations/paperless-ngx.ts";
import { NextcloudAdapter } from "./ironcrew/packs/integrations/nextcloud.ts";
import { Scheduler } from "./ironcrew/scheduler/scheduler.ts";
import { SearxngProvider } from "./ironcrew/search/searxng-provider.ts";
import { BraveProvider } from "./ironcrew/search/brave-provider.ts";
import { buildCrewJobs, intervalsFromEnv, schedulerEnabled } from "./ironcrew/scheduler/crew-jobs.ts";
import { CompanyOrchestrator } from "./ironcrew/orchestrator/company.ts";
import net from "node:net";
import { OpenRouterRuntime } from "./ironcrew/runtime/openrouter-runtime.ts";
import { RunnerRuntime } from "./ironcrew/runner/runner-client.ts";
import { RunnerMcpConnector } from "./ironcrew/runner/runner-mcp-client.ts";
import { MockRuntime } from "./ironcrew/runtime/mock-runtime.ts";
import { CliAdapterRuntime } from "./ironcrew/runtime/cli-adapter-runtime.ts";
import { VaultwardenSecretProvider } from "./ironcrew/secrets/vaultwarden-provider.ts";
import { KeychainSecretProvider } from "./ironcrew/secrets/keychain-provider.ts";
import { ProtonPassSecretProvider } from "./ironcrew/secrets/protonpass-provider.ts";
import { TailscaleProvider } from "./ironcrew/network/tailscale-provider.ts";
import { ObsidianProvider } from "./ironcrew/memory/obsidian-provider.ts";
import { DiscordChannel } from "./ironcrew/notify/discord-channel.ts";
import { TelegramChannel } from "./ironcrew/notify/telegram-channel.ts";
import { TelegramInboundChannel } from "./ironcrew/notify/telegram-inbound.ts";
import { DiscordInboundChannel } from "./ironcrew/notify/discord-inbound.ts";
import { EmailChannel } from "./ironcrew/notify/email-channel.ts";
import { ImapProvider } from "./ironcrew/mail/imap-provider.ts";
import { JmapProvider } from "./ironcrew/mail/jmap-provider.ts";
import { M365Provider } from "./ironcrew/mail/m365-provider.ts";
import { GmailProvider } from "./ironcrew/mail/gmail-provider.ts";
import { CatalogMarketplaceSource } from "./ironcrew/marketplace/catalog-source.ts";
import { McpRegistryMarketplaceSource } from "./ironcrew/marketplace/mcp-registry-source.ts";
import { ClaudePluginMarketplaceSource } from "./ironcrew/marketplace/claude-plugin-source.ts";
import { GitMarketplaceSource } from "./ironcrew/marketplace/git-source.ts";
import { MarketplaceInstaller, mcpManagerTarget } from "./ironcrew/marketplace/marketplace-installer.ts";
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

// ── The runner, if one is configured ──
//
// Computed here rather than at the CLI-runtime block below, because the MCP
// manager needs it first. One place decides whether a runner exists; both
// users read it.
const runnerTransport = process.env.IRONCREW_RUNNER_SOCKET
  ? {
      socketPath: process.env.IRONCREW_RUNNER_SOCKET,
      token: process.env.IRONCREW_RUNNER_TOKEN ?? "",
      connect: (): Promise<net.Socket> =>
        new Promise<net.Socket>((resolve, reject) => {
          const socket = net.connect(process.env.IRONCREW_RUNNER_SOCKET!);
          socket.setEncoding("utf-8");
          socket.once("connect", () => resolve(socket));
          socket.once("error", reject);
        }),
    }
  : null;

// ── MCP server connections ──
//
// A server whose credentials are SecretRefs is started on the runner, not
// here: resolving a vault item in this process would move the plaintext out
// of the database and straight into the memory of the one process that is
// meant to hold no credentials at all (mcp-secrets.ts, T-17). Everything else
// still runs inline, so a plain filesystem MCP server needs no runner.
//
// Both kinds arrive at the connector registry as the same `Connector`, under
// the same `mcp:<name>`, so tool grants keep working either way.
const mcpManager = new McpManager({
  createConnector: (config) => {
    if (!runnerTransport || !configHasSecretRefs(config)) return new McpConnector(config);
    return new RunnerMcpConnector({ config, token: runnerTransport.token, connect: runnerTransport.connect });
  },
});
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

// IronCrew control plane. Mounted under /api/crew and deliberately
// self-contained: it takes only the db handle and the broadcast function, so
// it carries no dependency on the upstream runtime god-object.
//
// Runtimes are registered explicitly rather than left to registerIronCrewRoutes()'s
// MockRuntime-only default: MockRuntime stays available for demos and tests,
// and every CLI-transport adapter this install already knows about (claude,
// codex, gemini, ...) is wrapped in a CliAdapterRuntime and registered too.
// Wrapping is unconditional — capabilities()/healthCheck()/authStatus() (the
// Provider Health panel, GET /api/crew/runtimes) are what tell an operator
// whether a given CLI is actually installed and logged in; a runtime that
// isn't simply reports itself unhealthy rather than being hidden.
const ironCrewOrchestrator = new CompanyOrchestrator(db);
ironCrewOrchestrator.registerRuntime(new MockRuntime());
// The first non-CLI runtime. Conditional on a key, like every other
// integration that needs configuration to be real — and note that the vendor
// policy is enforced *inside* it: one OpenRouter key reaches hundreds of
// models from dozens of vendors, so a run could otherwise arrive at a blocked
// one without anybody having chosen it.
if (process.env.OPENROUTER_API_KEY) {
  ironCrewOrchestrator.registerRuntime(
    new OpenRouterRuntime({
      apiKey: process.env.OPENROUTER_API_KEY,
      defaultModel: process.env.OPENROUTER_DEFAULT_MODEL,
    }),
  );
}
// CLI runtimes: in this process, or in the runner.
//
// With IRONCREW_RUNNER_SOCKET set, every CLI runtime is a RunnerRuntime that
// forwards to the daemon — which is the arrangement the threat model wants,
// because the CLI logins then live with the runner's own OS user and this
// process never holds one (docs/RUNNER_PROTOCOL.md, T-05). Without it they
// run inline, which is simpler and is why the shipped systemd unit has to
// move HOME to /var/lib/ironcrew for CLI credentials to work at all.
//
// Either way the orchestrator sees the same AgentRuntime contract and cannot
// tell the difference — that is what makes the security property free.
if (runnerTransport) {
  for (const adapter of adapterRegistry.list()) {
    if (!isCliAdapter(adapter)) continue;
    ironCrewOrchestrator.registerRuntime(
      new RunnerRuntime({
        runtimeType: adapter.providerType,
        token: runnerTransport.token,
        connect: runnerTransport.connect,
      }),
    );
  }
  logger.info({ socketPath: runnerTransport.socketPath }, "CLI runtimes are served by the runner daemon");
} else {
  for (const adapter of adapterRegistry.list()) {
    if (isCliAdapter(adapter)) ironCrewOrchestrator.registerRuntime(new CliAdapterRuntime(adapter));
  }
}
// Secret providers: same unconditional-wrapping posture as runtimes above —
// GET /api/crew/secret-providers (the Settings UI's provider status panel)
// is what tells an operator whether `bw`/`pass-cli` are actually installed
// and authenticated; wrapping them here never assumes they are.
ironCrewOrchestrator.registerSecretProvider(
  new VaultwardenSecretProvider({ serverUrl: process.env.VAULTWARDEN_SERVER_URL }),
);
ironCrewOrchestrator.registerSecretProvider(new ProtonPassSecretProvider());
// The OS keychain, third alongside the two vaults. Registering it says this
// server *can* read one; testConnection() is what says whether it actually
// can — on a headless service there is no session bus and no unlocked
// collection, and it reports that rather than failing later inside a run
// (server/ironcrew/secrets/keychain-provider.ts).
ironCrewOrchestrator.registerSecretProvider(new KeychainSecretProvider());
// Same posture again: GET /api/crew/tailscale (the Netzwerk panel) reports
// whether this node is actually on a tailnet rather than assuming it is.
ironCrewOrchestrator.registerTailscaleProvider(new TailscaleProvider({ tailscalePath: process.env.TAILSCALE_BIN }));
// Unlike the providers above, ObsidianProvider needs a real vault path to
// even construct — with none configured, GET /api/crew/memory-providers
// correctly reports "obsidian" as not registered rather than pointing at a
// nonsensical default directory.
if (process.env.OBSIDIAN_VAULT_PATH) {
  ironCrewOrchestrator.registerMemoryProvider(new ObsidianProvider({ vaultPath: process.env.OBSIDIAN_VAULT_PATH }));
}
// Notification channels: same conditional posture as ObsidianProvider above
// — each needs real configuration to even construct, so an unconfigured
// channel is simply never registered rather than wrapping a broken one.
if (process.env.DISCORD_WEBHOOK_URL) {
  ironCrewOrchestrator.registerNotificationChannel(new DiscordChannel({ webhookUrl: process.env.DISCORD_WEBHOOK_URL }));
}
if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
  ironCrewOrchestrator.registerNotificationChannel(
    new TelegramChannel({ botToken: process.env.TELEGRAM_BOT_TOKEN, chatId: process.env.TELEGRAM_CHAT_ID }),
  );
}
// Messenger channels are the *receiving* half, and they are registered from
// their own variables rather than reusing the outbound ones on purpose.
// Outbound Telegram needs a chat id to push at; inbound needs none, because
// the chat a message arrived in is where the reply goes. Outbound Discord is
// a webhook, which cannot read at all — reading needs a bot token and one
// channel to watch. Sharing a variable between the two would mean a webhook
// URL silently enabling an ingress, which is the opposite of what an
// operator setting DISCORD_WEBHOOK_URL asked for.
//
// Registering a channel does not open the door: nothing is polled until
// POST /api/crew/messenger-channels/:kind/poll is called, and nothing an
// unknown sender writes is acted on until the owner pairs them
// (docs/MESSENGER.md).
if (process.env.TELEGRAM_BOT_TOKEN) {
  ironCrewOrchestrator.registerMessengerChannel(
    new TelegramInboundChannel({ botToken: process.env.TELEGRAM_BOT_TOKEN }),
  );
}
if (process.env.DISCORD_BOT_TOKEN && process.env.DISCORD_INBOUND_CHANNEL_ID) {
  ironCrewOrchestrator.registerMessengerChannel(
    new DiscordInboundChannel({
      botToken: process.env.DISCORD_BOT_TOKEN,
      channelId: process.env.DISCORD_INBOUND_CHANNEL_ID,
    }),
  );
}
if (process.env.SMTP_HOST && process.env.SMTP_FROM && process.env.SMTP_TO) {
  ironCrewOrchestrator.registerNotificationChannel(
    new EmailChannel({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT ?? 587),
      secure: process.env.SMTP_SECURE === "true",
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
      from: process.env.SMTP_FROM,
      to: process.env.SMTP_TO,
    }),
  );
}
// Mail providers: unconditional, like runtimes and secret providers above.
// Each carries no configuration of its own — a mailbox row supplies host,
// credentials and the rest per call — so registering all four simply means
// "this server can speak IMAP, JMAP, Graph and Gmail". Whether a given
// mailbox actually connects is what POST /api/crew/mailboxes/:id/test says.
ironCrewOrchestrator.registerMailProvider(new ImapProvider());
ironCrewOrchestrator.registerMailProvider(new JmapProvider());
ironCrewOrchestrator.registerMailProvider(new M365Provider());
ironCrewOrchestrator.registerMailProvider(new GmailProvider());

// Marketplaces: the four source adapters, plus the installer that writes
// what an admin approves into the infrastructure that already exists —
// McpManager's settings row for servers, custom-skills/ for skills. Both
// halves are needed for an install; registering the adapters alone would
// let a source be browsed but never installed from.
ironCrewOrchestrator.registerMarketplaceSource(new CatalogMarketplaceSource());
ironCrewOrchestrator.registerMarketplaceSource(new McpRegistryMarketplaceSource());
ironCrewOrchestrator.registerMarketplaceSource(new ClaudePluginMarketplaceSource());
ironCrewOrchestrator.registerMarketplaceSource(new GitMarketplaceSource());
ironCrewOrchestrator.registerMarketplaceInstaller(
  new MarketplaceInstaller({
    mcp: mcpManagerTarget({
      addServer: (config) => mcpManager.addServer(config),
      removeServer: (name) => mcpManager.removeServer(name, connectorRegistry),
      getConfig: (name) => mcpManager.getConfig(name),
      persist: () => mcpManager.saveToSettings(db),
    }),
    // The same directory the custom-skills route uses (logsDir's parent).
    skillsDir: path.join(logsDir, "..", "custom-skills"),
  }),
);

// Declared before the routes and assigned after: the scheduler needs the
// company id that registering the routes produces, and the routes need to be
// able to reach the scheduler. A callback breaks the cycle without either
// side holding a half-built object.
let ironCrewScheduler: Scheduler | null = null;

// Tools, and what may be done with them.
//
// Registering is not granting: `crew_tools` says what this server can perform,
// `crew_tool_grants` says who may. Booting with every built-in registered is
// therefore safe, and an operator who disabled one keeps it disabled
// (docs/TOOLS.md). MCP servers are mirrored in as tools so they sit behind the
// same gate rather than in a second permission system.
//
// Search and browser providers are registered on the same conditional posture
// as the notification channels: no configuration, no registration, and the
// Settings UI reports honestly that nothing is there.
if (process.env.SEARXNG_URL) {
  ironCrewOrchestrator.registerSearchProvider(new SearxngProvider({ baseUrl: process.env.SEARXNG_URL }));
}
if (process.env.BRAVE_SEARCH_API_KEY) {
  ironCrewOrchestrator.registerSearchProvider(new BraveProvider({ apiKey: process.env.BRAVE_SEARCH_API_KEY }));
}

// A second way to prove who you are, when the operator already runs a
// directory. Off unless configured: a self-hosted single-operator box does
// not need an identity provider, and adding one would add a dependency that
// must be online for anyone to log in.
//
// The password login stays regardless. The day the directory is down or
// misconfigured is exactly the day somebody has to sign in and fix it.
function buildOidcProvider(): OidcProvider | null {
  const issuer = process.env.IRONCREW_OIDC_ISSUER?.trim();
  if (!issuer) return null;

  const clientId = process.env.IRONCREW_OIDC_CLIENT_ID?.trim();
  const redirectUri = process.env.IRONCREW_OIDC_REDIRECT_URI?.trim();
  // Refused rather than defaulted. A guessed redirect URI does not match what
  // is registered at the issuer, so the login fails at the far end with a
  // message about the client — which is a long way from the variable that was
  // actually missing.
  if (!clientId || !redirectUri) {
    throw new Error(
      "IRONCREW_OIDC_ISSUER is set, so IRONCREW_OIDC_CLIENT_ID and IRONCREW_OIDC_REDIRECT_URI are required.",
    );
  }

  const rawMode = (process.env.IRONCREW_OIDC_PROVISIONING ?? "refuse").trim() as OidcProvisioningMode;
  if (!(OIDC_PROVISIONING_MODES as readonly string[]).includes(rawMode)) {
    throw new Error(
      `IRONCREW_OIDC_PROVISIONING="${rawMode}" is not a mode. One of: ${OIDC_PROVISIONING_MODES.join(", ")}.`,
    );
  }

  return new OidcProvider(
    {
      issuer,
      clientId,
      clientSecret: process.env.IRONCREW_OIDC_CLIENT_SECRET,
      redirectUri,
      // Default "refuse": a verified directory subject with no linked account
      // gets a readable refusal, never an account. Anything else is an opt-in
      // an operator makes deliberately (docs/IDENTITY.md).
      provisioning:
        rawMode === "create"
          ? { mode: "create", role: (process.env.IRONCREW_OIDC_CREATE_ROLE as "operator" | "viewer") || "viewer" }
          : { mode: rawMode },
    },
    { db },
  );
}

const ironCrewOidc = buildOidcProvider();

const ironCrewApi = registerIronCrewRoutes(app, {
  db,
  oidc: ironCrewOidc,
  broadcast: (runtimeContext as unknown as { broadcast: (e: string, p: unknown) => void }).broadcast,
  orchestrator: ironCrewOrchestrator,
  scheduler: () => ironCrewScheduler,
});

// The audit chain, carried off the box.
//
// An append-only hash chain proves nobody edited the record. It cannot prove
// nobody *deleted* it — whoever owns the box owns the file, and a chain that
// only exists on the machine it describes is a chain an attacker can replace
// wholesale with a shorter, quieter one. So a copy leaves, continuously, to
// somewhere the box's own credentials do not reach.
//
// Off by default and configured by presence, like every other integration
// here. IRONCREW_AUDIT_SINK names which; nothing is inferred from a stray URL,
// because an operator who set the variable and mistyped the value deserves a
// refusal rather than a silently disabled control.
const auditSinkKind = (process.env.IRONCREW_AUDIT_SINK ?? "").trim().toLowerCase();
if (auditSinkKind === "file") {
  const filePath = process.env.IRONCREW_AUDIT_FILE?.trim();
  if (!filePath) {
    // Loud, and not a fallback to "off": a half-configured audit sink that
    // quietly ships nothing is worse than none, because somebody believes
    // they have a copy.
    throw new Error("IRONCREW_AUDIT_SINK=file requires IRONCREW_AUDIT_FILE to name the target file.");
  }
  ironCrewOrchestrator.registerAuditShipper(
    new AuditShipper({ db, sink: new FileAuditSink({ filePath }), cursorNamespace: "file" }),
  );
} else if (auditSinkKind === "http") {
  const url = process.env.IRONCREW_AUDIT_URL?.trim();
  if (!url) {
    throw new Error("IRONCREW_AUDIT_SINK=http requires IRONCREW_AUDIT_URL to name the collector endpoint.");
  }
  ironCrewOrchestrator.registerAuditShipper(
    new AuditShipper({
      db,
      // The token travels in a header inside the sink and nowhere else. It is
      // read here and never logged, never echoed by the status route.
      sink: new HttpAuditSink({ url, bearerToken: process.env.IRONCREW_AUDIT_TOKEN }),
      cursorNamespace: "http",
    }),
  );
} else if (auditSinkKind !== "" && auditSinkKind !== "off") {
  throw new Error(`IRONCREW_AUDIT_SINK="${auditSinkKind}" is not a sink kind. Use "file", "http", or leave it unset.`);
}

// Business-pack integrations: registered only when their environment says so.
//
// This is Phase 4's "every integration ships behind a feature flag as a real
// adapter — no fake buttons" expressed as code. An adapter that is not
// constructed here is not registered, so GET /api/crew/packs reports it as
// not configured, and the Command Center shows what is missing rather than a
// switch that fails when pressed. Adding an adapter therefore costs exactly
// one `if` — and forgetting the `if` costs a test in catalog.test.ts.
//
// All seven are read-only. An MSP's RMM key can run a script on every managed
// endpoint, a Lexware key can issue a legally binding invoice: those are
// writes, and a write belongs behind an approval, not behind an environment
// variable (docs/BUSINESS_PACKS.md).
if (process.env.PROXMOX_URL && process.env.PROXMOX_TOKEN_ID && process.env.PROXMOX_TOKEN_SECRET) {
  ironCrewOrchestrator.registerPackIntegration(
    new ProxmoxAdapter({
      baseUrl: process.env.PROXMOX_URL,
      tokenId: process.env.PROXMOX_TOKEN_ID,
      tokenSecret: process.env.PROXMOX_TOKEN_SECRET,
    }),
  );
}
if (process.env.TACTICAL_RMM_URL && process.env.TACTICAL_RMM_API_KEY) {
  ironCrewOrchestrator.registerPackIntegration(
    new TacticalRmmAdapter({ baseUrl: process.env.TACTICAL_RMM_URL, apiKey: process.env.TACTICAL_RMM_API_KEY }),
  );
}
if (process.env.UNIFI_URL && process.env.UNIFI_API_KEY) {
  ironCrewOrchestrator.registerPackIntegration(
    new UnifiAdapter({
      baseUrl: process.env.UNIFI_URL,
      apiKey: process.env.UNIFI_API_KEY,
      site: process.env.UNIFI_SITE,
    }),
  );
}
if (process.env.LEXWARE_OFFICE_API_KEY) {
  ironCrewOrchestrator.registerPackIntegration(
    new LexwareOfficeAdapter({
      apiKey: process.env.LEXWARE_OFFICE_API_KEY,
      baseUrl: process.env.LEXWARE_OFFICE_URL,
    }),
  );
}
// The finance pack declares two bookkeeping systems because a company runs
// one of them; the `if` decides which, and an owner who runs neither gets
// neither. Both stay read-only — a sevDesk key can issue an invoice, and an
// invoice is a legally binding statement, so it belongs behind an approval
// rather than behind an environment variable.
if (process.env.SEVDESK_API_KEY) {
  ironCrewOrchestrator.registerPackIntegration(
    new SevdeskAdapter({
      apiKey: process.env.SEVDESK_API_KEY,
      baseUrl: process.env.SEVDESK_URL,
    }),
  );
}
if (process.env.PAPERLESS_URL && process.env.PAPERLESS_TOKEN) {
  ironCrewOrchestrator.registerPackIntegration(
    new PaperlessAdapter({ baseUrl: process.env.PAPERLESS_URL, token: process.env.PAPERLESS_TOKEN }),
  );
}
if (process.env.NEXTCLOUD_URL && process.env.NEXTCLOUD_USER && process.env.NEXTCLOUD_APP_PASSWORD) {
  ironCrewOrchestrator.registerPackIntegration(
    new NextcloudAdapter({
      baseUrl: process.env.NEXTCLOUD_URL,
      username: process.env.NEXTCLOUD_USER,
      appPassword: process.env.NEXTCLOUD_APP_PASSWORD,
    }),
  );
}

// One login, not two. Someone who signed in with their own account satisfies
// the generic HTTP security layer as well: a crew session is the stronger
// credential — it names a person, expires and can be revoked — and asking for
// the shared password on top would keep that password in circulation, which
// is precisely what accounts are meant to end (docs/IDENTITY.md).
setCrewSessionResolver((token, ip, userAgent) => ironCrewApi.auth.sessions.resolve(token, { ip, userAgent }) !== null);

// The background loop — the difference between a program someone operates and
// a service that runs. Without it the run queue only drains when a person
// presses a button, which is exactly the situation the queue exists to end
// (docs/RUN_QUEUE.md, docs/SERVICE.md).
//
// Registered here rather than inside registerIronCrewRoutes because a timer
// is a property of *this process*, not of the routes: the test suite mounts
// those routes hundreds of times and must not start a hundred loops.
ironCrewOrchestrator.ensureBuiltinTools(ironCrewApi.companyId);
try {
  const mcpNames = (
    runtimeContext as unknown as { mcpManager?: { getAllConfigs(): Array<{ name: string }> } }
  ).mcpManager
    ?.getAllConfigs()
    .map((c) => c.name);
  if (mcpNames) {
    const synced = ironCrewOrchestrator.syncMcpTools(ironCrewApi.companyId, mcpNames);
    if (synced.added > 0 || synced.disabled > 0) logger.info(synced, "MCP servers mirrored into the tool registry");
  }
} catch (err) {
  // Never fatal: a tool registry that failed to mirror leaves every MCP
  // server ungranted, which is the safe direction. Booting without a control
  // plane because of it would not be.
  logger.warn({ err }, "could not mirror MCP servers into the tool registry");
}

ironCrewScheduler = schedulerEnabled()
  ? new Scheduler({
      jobs: buildCrewJobs({
        orchestrator: ironCrewOrchestrator,
        companyId: ironCrewApi.companyId,
        intervals: intervalsFromEnv(),
        broadcast: (runtimeContext as unknown as { broadcast: (e: string, p: unknown) => void }).broadcast,
      }),
    })
  : null;

if (ironCrewScheduler) {
  ironCrewScheduler.start();
} else {
  logger.info("IronCrew scheduler disabled via IRONCREW_SCHEDULER");
}

// systemd sends SIGTERM and waits. This handler exists only to stop the loop
// from *starting* new work; it deliberately does not exit the process.
//
// registerGracefulShutdownHandlers (modules/lifecycle.ts) already owns
// shutdown: it stops child processes, rolls back worktrees, closes the
// websockets, closes the database and then exits. A second handler calling
// process.exit() would race that sequence and could cut it off mid-way —
// closing the database out from under a rollback is a good deal worse than
// a scheduler tick that never happened.
//
// `stop()` clears the timers synchronously before it awaits, so by the time
// the graceful sequence runs, nothing new can start. A run already in flight
// may still be cut off, and that is what the run request's lease is for: it
// expires and the request is reclaimed on the next drain.
let schedulerStopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (schedulerStopping) return;
    schedulerStopping = true;
    void ironCrewScheduler?.stop();
  });
}

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
