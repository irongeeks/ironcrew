import type { RuntimeContext } from "../../../../types/runtime-context.ts";
import { registerAgentCrudRoutes } from "./crud.ts";
import { registerAgentProcessInspectorRoutes } from "./process-inspector.ts";
import { registerAgentSpawnRoute } from "./spawn.ts";
import { registerSpriteRoutes } from "./sprites.ts";

export function registerAgentRoutes(ctx: RuntimeContext): void {
  registerAgentProcessInspectorRoutes(ctx);
  registerAgentCrudRoutes(ctx);
  registerSpriteRoutes(ctx);
  registerAgentSpawnRoute(
    { app: ctx.app, db: ctx.db, logsDir: ctx.logsDir, nowMs: ctx.nowMs, broadcast: ctx.broadcast },
    {
      buildTaskExecutionPrompt: ctx.buildTaskExecutionPrompt,
      hasExplicitWarningFixRequest: ctx.hasExplicitWarningFixRequest,
      ensureClaudeMd: ctx.ensureClaudeMd,
      launchApiProviderAgent: ctx.launchApiProviderAgent,
      launchHttpAgent: ctx.launchHttpAgent,
      spawnCliAgent: ctx.spawnCliAgent,
      buildAvailableSkillsPromptBlock: ctx.buildAvailableSkillsPromptBlock,
    },
    {
      createWorktree: ctx.createWorktree,
      ensureTaskExecutionSession: ctx.ensureTaskExecutionSession,
      getDeptRoleConstraint: ctx.getDeptRoleConstraint,
      normalizeTextField: ctx.normalizeTextField,
      appendTaskLog: ctx.appendTaskLog,
      getProviderModelConfig: ctx.getProviderModelConfig,
      getNextHttpAgentPid: ctx.getNextHttpAgentPid,
      handleTaskRunComplete: ctx.handleTaskRunComplete,
    },
    {
      resolveLang: ctx.resolveLang,
      pickL: ctx.pickL,
      l: ctx.l,
    },
  );
}
