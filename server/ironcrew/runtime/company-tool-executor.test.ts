import { describe, expect, it, vi } from "vitest";
import { createCompanyToolExecutor, type CompanyToolCallbacks } from "./company-tool-executor.ts";
import type { RunContext } from "./run-events.ts";

const context: RunContext = {
  companyId: "company-a",
  taskId: "task-a",
  projectId: "project-a",
  runId: "run-a",
  agentId: "agent-a",
  correlationId: "corr-a",
  workspacePath: "",
  permissionMode: "restricted",
};
function callbacks(overrides: Partial<CompanyToolCallbacks> = {}): CompanyToolCallbacks {
  return {
    companyId: "company-a",
    permitted: vi.fn(async () => true),
    authorize: vi.fn(async () => ({ status: "allowed" as const })),
    listTasks: vi.fn(async () => [{ id: "task-a", company_id: "company-a" }]),
    readTask: vi.fn(async () => ({ id: "task-a", company_id: "company-a" })),
    searchMemory: vi.fn(async () => [{ content: "SOP", source: "vault/sop.md" }]),
    audit: vi.fn(async () => undefined),
    ...overrides,
  };
}
const call = (name: string, args: Record<string, unknown> = {}) => ({ id: "call-a", name, arguments: args });

describe("company runtime tools", () => {
  it("only advertises explicitly granted registry tools", async () => {
    const deps = callbacks({ permitted: vi.fn(async (key) => key === "task.read") });
    const tools = await createCompanyToolExecutor(deps).listTools(context);
    expect(tools.map((tool) => tool.name)).toEqual(["task_read"]);
  });

  it("routes task and memory reads using trusted run identity and bounded counts", async () => {
    const deps = callbacks();
    const executor = createCompanyToolExecutor(deps);
    expect(await executor.execute(call("task_list", { limit: 1 }), context)).toHaveLength(1);
    expect(await executor.execute(call("task_read", { taskId: "task-a" }), context)).toMatchObject({ id: "task-a" });
    expect(await executor.execute(call("memory_search", { query: "SOP", limit: 3 }), context)).toHaveLength(1);
    expect(deps.searchMemory).toHaveBeenCalledWith(context, "SOP", 3);
    await expect(executor.execute(call("task_list", { limit: 101 }), context)).rejects.toThrow();
  });

  it("refuses foreign company context and foreign task results", async () => {
    const deps = callbacks({ readTask: vi.fn(async () => ({ id: "foreign", company_id: "company-b" })) });
    const executor = createCompanyToolExecutor(deps);
    await expect(executor.listTools({ ...context, companyId: "company-b" })).rejects.toThrow(/Scope/);
    await expect(executor.execute(call("task_read", { taskId: "foreign" }), context)).rejects.toThrow(/andere/);
  });

  it("rechecks grants before execution and rejects invented tools", async () => {
    const deps = callbacks({ authorize: vi.fn(async () => ({ status: "denied" as const, reason: "revoked" })) });
    const executor = createCompanyToolExecutor(deps);
    await expect(executor.execute(call("task_read", { taskId: "task-a" }), context)).rejects.toThrow(/widerrufen/);
    await expect(executor.execute(call("shell_exec", { command: "anything" }), context)).rejects.toThrow(/Unbekannt/);
    expect(deps.readTask).not.toHaveBeenCalled();
  });

  it("turns approval requests into the normal persistent approval event path without executing the action", async () => {
    const deps = callbacks();
    const executor = createCompanyToolExecutor(deps);
    const request = call("approval_request", { approvalType: "production_deployment", summary: "Release deployen" });
    expect(await executor.authorize(request, context)).toMatchObject({
      status: "approval_required" as const,
      approvalType: "production_deployment",
    });
    await expect(executor.execute(request, context)).rejects.toThrow(/keine Aktion/);
  });

  it("passes audit ownership to a durable callback rather than swallowing failures", async () => {
    const deps = callbacks({
      audit: vi.fn(async () => {
        throw new Error("database unavailable");
      }),
    });
    await expect(createCompanyToolExecutor(deps).audit("started", call("task_list"), context)).rejects.toThrow(
      "database unavailable",
    );
  });
});
