import type { RuntimeContext, RouteOpsExports } from "../../types/runtime-context.ts";
import type { OAuthContext } from "../../types/runtime-context-domains.ts";

import { registerOpsMessageRoutes } from "./ops/messages.ts";
import { registerApiProviderRoutes } from "./ops/api-providers.ts";
import { registerOpsSettingsStatsRoutes } from "./ops/settings-stats.ts";
import { prettyStreamJson } from "./ops/terminal/pretty-stream-json.ts";
import { registerTaskTerminalRoutes } from "./ops/terminal/routes.ts";
import { registerCustomSkillRoutes } from "./ops/custom-skills.ts";
import { registerWorktreeAndUsageRoutes } from "./ops/worktrees-and-usage.ts";
import { registerTaskReportRoutes } from "./ops/task-reports/routes.ts";
import { registerModelRoutes } from "./ops/models-routes.ts";
import { registerOAuthRoutes } from "./ops/oauth/routes.ts";
import { registerCliAuthRoutes } from "./ops/cli-auth/routes.ts";
import { registerSkillRoutes } from "./ops/skills/routes.ts";
import { registerApiDocsRoutes } from "./ops/api-docs.ts";
import { registerWorkflowPackRoutes } from "./ops/workflow-packs.ts";
import { registerServerManagementRoutes } from "./ops/servers.ts";
import { registerServerSshRoutes } from "./ops/server-ssh.ts";
import { registerComfyUiWorkflowRoutes } from "./ops/comfyui-workflows.ts";
import { registerConnectorRoutes } from "./ops/connectors.ts";
import { registerMcpServerRoutes } from "./ops/mcp-servers.ts";
import { registerOperationsRoutes } from "./ops/operations.ts";
import { registerObservabilityRoutes } from "./ops/observability.ts";
import { registerTokenUsageRoutes } from "./ops/token-usage.ts";
import { registerTaskBrowseRoutes } from "./ops/task-browse.ts";
import { registerSetupStatusRoutes } from "./ops/setup-status.ts";
import { registerScheduledTaskRoutes } from "./ops/scheduled-tasks.ts";
import { registerDocsRoutes } from "./docs/index.ts";
import { httpError } from "./http-errors.ts";

export function registerRoutesPartC(ctx: RuntimeContext, oauthCtx: OAuthContext): RouteOpsExports {
  const __ctx: RuntimeContext = ctx;
  const CLI_STATUS_TTL = __ctx.CLI_STATUS_TTL;
  const app = __ctx.app;
  const appendTaskLog = __ctx.appendTaskLog;
  let cachedCliStatus = __ctx.cachedCliStatus;
  const db = __ctx.db;
  const detectAllCli = __ctx.detectAllCli;
  const normalizeTextField = __ctx.normalizeTextField;
  const nowMs = __ctx.nowMs;
  const taskWorktrees = __ctx.taskWorktrees;

  Object.assign(__ctx, registerOpsMessageRoutes(__ctx));

  // ---------------------------------------------------------------------------
  // CLI Status
  // ---------------------------------------------------------------------------
  app.get("/api/cli-status", async (_req, res) => {
    const refresh = _req.query.refresh === "1";
    const now = Date.now();

    if (!refresh && cachedCliStatus && now - cachedCliStatus.loadedAt < CLI_STATUS_TTL) {
      return res.json({ providers: cachedCliStatus.data });
    }

    try {
      const data = await detectAllCli();
      cachedCliStatus = { data, loadedAt: Date.now() };
      res.json({ providers: data });
    } catch (err) {
      console.error("[ops] cli_detection_failed:", err);
      httpError(res, 500, "cli_detection_failed", "Failed to detect CLI providers");
    }
  });

  // ---------------------------------------------------------------------------
  // Settings / Stats
  // ---------------------------------------------------------------------------
  registerOpsSettingsStatsRoutes(__ctx);
  registerApiDocsRoutes({ app });

  // ---------------------------------------------------------------------------
  // Task terminal log viewer
  // ---------------------------------------------------------------------------
  registerTaskTerminalRoutes(__ctx);

  registerOAuthRoutes(__ctx.app, oauthCtx, {
    db: __ctx.db,
    nowMs: __ctx.nowMs,
    firstQueryValue: __ctx.firstQueryValue,
    ensureOAuthActiveAccount: __ctx.ensureOAuthActiveAccount,
    getActiveOAuthAccountIds: __ctx.getActiveOAuthAccountIds,
    setActiveOAuthAccount: __ctx.setActiveOAuthAccount,
    setOAuthActiveAccounts: __ctx.setOAuthActiveAccounts,
    removeActiveOAuthAccount: __ctx.removeActiveOAuthAccount,
  });
  registerCliAuthRoutes({
    app: __ctx.app,
    detectAllCli: __ctx.detectAllCli,
  });

  registerModelRoutes(__ctx);

  const { normalizeSkillLearnProviders } = registerSkillRoutes(__ctx);
  registerCustomSkillRoutes(__ctx, { normalizeSkillLearnProviders });

  const { refreshCliUsageData } = registerWorktreeAndUsageRoutes(__ctx);

  // ---------------------------------------------------------------------------
  // API Providers (direct API key-based LLM access)
  // ---------------------------------------------------------------------------
  registerApiProviderRoutes({
    app,
    db,
    nowMs,
  });
  registerWorkflowPackRoutes({
    app,
    db,
    nowMs,
    normalizeTextField,
    packRegistry: __ctx.packRegistry,
    adapterRegistry: __ctx.adapterRegistry,
    connectorRegistry: __ctx.connectorRegistry,
    nodeTypeRegistry: __ctx.nodeTypeRegistry,
  });

  registerTaskReportRoutes(__ctx);
  registerServerManagementRoutes(__ctx);
  registerServerSshRoutes(__ctx);
  registerComfyUiWorkflowRoutes(__ctx);
  registerConnectorRoutes(__ctx);
  registerMcpServerRoutes(__ctx);
  registerOperationsRoutes(__ctx);
  registerObservabilityRoutes(app, db);
  registerTokenUsageRoutes(__ctx);
  registerTaskBrowseRoutes(__ctx);
  registerSetupStatusRoutes(__ctx);
  registerScheduledTaskRoutes(__ctx);
  registerDocsRoutes({
    app,
    db,
    nowMs,
    appendTaskLog,
    taskWorktrees,
  });

  return {
    prettyStreamJson,
    refreshCliUsageData,
  };
}
