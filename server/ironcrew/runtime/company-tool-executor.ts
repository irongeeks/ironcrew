/** Narrow company tools. No shell, network, business writes or approval decisions.
 * Callbacks are bound to the control plane; identity always comes from RunContext.
 */
import { z } from "zod";
import { ALWAYS_APPROVAL_REQUIRED, RISK_LEVELS } from "../policy/approval-policy.ts";
import type { RunContext } from "./run-events.ts";
import type { OpenRouterToolAuthorization, OpenRouterToolCall, OpenRouterToolExecutor } from "./openrouter-tools.ts";

export const COMPANY_RUNTIME_TOOLS = {
  task_list: "task.list",
  task_read: "task.read",
  memory_search: "memory.search",
  approval_request: "approval.request",
} as const;

const schemas = {
  task_list: z.object({ limit: z.number().int().min(1).max(100).optional() }).strict(),
  task_read: z.object({ taskId: z.string().min(1).max(200) }).strict(),
  memory_search: z
    .object({ query: z.string().min(1).max(2000), limit: z.number().int().min(1).max(20).optional() })
    .strict(),
  approval_request: z
    .object({
      approvalType: z.enum(ALWAYS_APPROVAL_REQUIRED),
      summary: z.string().min(1).max(2000),
      riskLevel: z.enum(RISK_LEVELS).optional(),
    })
    .strict(),
};
const descriptions = {
  task_list: "Liest Aufgaben der aktuellen Firma.",
  task_read: "Liest eine Aufgabe der aktuellen Firma.",
  memory_search: "Sucht Quellen im freigegebenen Firmenwissen.",
  approval_request: "Fordert eine CEO-Freigabe an. Führt die beantragte Aktion nicht aus.",
};

export interface CompanyToolCallbacks {
  companyId: string;
  /** Registry visibility: enabled and explicitly granted to this agent/project. */
  permitted(toolKey: string, context: RunContext): Promise<boolean>;
  /** Recheck the current registry grant and any approval immediately before use. */
  authorize(toolKey: string, context: RunContext, call: OpenRouterToolCall): Promise<OpenRouterToolAuthorization>;
  listTasks(context: RunContext, limit: number): Promise<unknown[]>;
  readTask(context: RunContext, taskId: string): Promise<unknown | null>;
  searchMemory(context: RunContext, query: string, limit: number): Promise<unknown>;
  audit: OpenRouterToolExecutor["audit"];
}

export function createCompanyToolExecutor(callbacks: CompanyToolCallbacks): OpenRouterToolExecutor {
  const assertScope = (context: RunContext) => {
    if (context.companyId !== callbacks.companyId || !context.agentId)
      throw new Error("Ungültiger Firmen-/Agent-Scope.");
    context.signal?.throwIfAborted();
  };
  const keyFor = (name: string) => {
    if (!Object.hasOwn(COMPANY_RUNTIME_TOOLS, name)) throw new Error("Unbekanntes Firmenwerkzeug.");
    return name as keyof typeof COMPANY_RUNTIME_TOOLS;
  };
  const scopedTask = (record: unknown) => {
    const task = z.object({ company_id: z.string() }).passthrough().parse(record);
    if (task.company_id !== callbacks.companyId) throw new Error("Aufgabe gehört zu einer anderen Firma.");
    return task;
  };
  return {
    async listTools(context) {
      assertScope(context);
      const tools = [];
      for (const name of Object.keys(COMPANY_RUNTIME_TOOLS) as Array<keyof typeof COMPANY_RUNTIME_TOOLS>) {
        if (await callbacks.permitted(COMPANY_RUNTIME_TOOLS[name], context)) {
          tools.push({ name, description: descriptions[name], inputSchema: schemas[name] });
        }
      }
      return tools;
    },
    async authorize(call, context) {
      assertScope(context);
      const name = keyFor(call.name);
      schemas[name].parse(call.arguments);
      const decision = await callbacks.authorize(COMPANY_RUNTIME_TOOLS[name], context, call);
      if (decision.status !== "allowed" || name !== "approval_request" || decision.approvalId) return decision;
      const input = schemas.approval_request.parse(call.arguments);
      // The normal approval.required RunEvent creates the persistent approval
      // through the orchestrator. No independent, duplicate approval is minted.
      return { status: "approval_required", ...input, riskLevel: input.riskLevel ?? "high" };
    },
    async execute(call, context) {
      assertScope(context);
      const name = keyFor(call.name);
      // Defence in depth for callers using the helper outside OpenRouter.
      const decision = await callbacks.authorize(COMPANY_RUNTIME_TOOLS[name], context, call);
      if (decision.status !== "allowed") throw new Error("Werkzeugfreigabe fehlt oder wurde widerrufen.");
      switch (name) {
        case "task_list": {
          const input = schemas.task_list.parse(call.arguments);
          return (await callbacks.listTasks(context, input.limit ?? 20)).slice(0, input.limit ?? 20).map(scopedTask);
        }
        case "task_read": {
          const input = schemas.task_read.parse(call.arguments);
          const task = await callbacks.readTask(context, input.taskId);
          return task === null ? null : scopedTask(task);
        }
        case "memory_search": {
          const input = schemas.memory_search.parse(call.arguments);
          return callbacks.searchMemory(context, input.query, input.limit ?? 5);
        }
        case "approval_request": {
          schemas.approval_request.parse(call.arguments);
          if (!decision.approvalId) throw new Error("Eine Freigabeanforderung führt keine Aktion aus.");
          return { approvalId: decision.approvalId, status: "approved", actionExecuted: false };
        }
        default:
          throw new Error("Eine Freigabeanforderung führt keine Aktion aus.");
      }
    },
    audit: callbacks.audit,
  };
}
