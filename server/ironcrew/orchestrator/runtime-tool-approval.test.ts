import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { ObsidianProvider } from "../memory/obsidian-provider.ts";
import type { DatabaseSync } from "node:sqlite";
import { createTestDb } from "../domain/test-db.ts";
import { configDir, loadCrewConfig, loadDepartmentConfig } from "../domain/crew-config.ts";
import { verifyAuditChain } from "../domain/audit.ts";
import { OpenRouterRuntime } from "../runtime/openrouter-runtime.ts";
import { toolApprovalBinding } from "../runtime/tool-approval-binding.ts";
import type { OpenRouterToolCall } from "../runtime/openrouter-tools.ts";
import type { RunContext } from "../runtime/run-events.ts";
import { CompanyOrchestrator } from "./company.ts";

const crew = loadCrewConfig(undefined, path.join(configDir(), "private", "__no_such_pack__.local.yaml"));
let db: DatabaseSync;
let orc: CompanyOrchestrator;
let companyId: string;
const vaults: string[] = [];
beforeEach(() => {
  db = createTestDb();
  orc = new CompanyOrchestrator(db);
  companyId = orc.seedCompany({ name: "Approvals", slug: "tools", crew, departments: loadDepartmentConfig() });
});
afterEach(() => {
  db.close();
  for (const vault of vaults.splice(0)) fs.rmSync(vault, { recursive: true, force: true });
});

function setup() {
  const task = orc.handleCeoMessage(companyId, "Bitte dokumentiere das Deployment-Verfahren.").task!;
  let nextCall: OpenRouterToolCall = { id: "call_first", name: "memory_search", arguments: { query: "SOP", limit: 3 } };
  const executor = orc.runtimeToolExecutor(companyId);
  for (const key of ["memory.search", "task.read", "approval.request"]) {
    orc.tools.grant({
      toolId: orc.tools.byKey(companyId, key)!.id,
      agentId: task.assigned_agent_id!,
      requiresApproval: true,
    });
  }
  const execute = vi.spyOn(executor, "execute");
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string }> };
    const complete = body.messages.some((message) => message.role === "tool");
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: complete
              ? { content: "Abgeschlossen" }
              : {
                  content: null,
                  tool_calls: [
                    {
                      id: nextCall.id,
                      type: "function",
                      function: { name: nextCall.name, arguments: JSON.stringify(nextCall.arguments) },
                    },
                  ],
                },
            finish_reason: complete ? "stop" : "tool_calls",
          },
        ],
        usage: { prompt_tokens: 4, completion_tokens: 2, cost: 0 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  });
  orc.registerRuntime(new OpenRouterRuntime({ apiKey: "offline-fixture-secret", fetchImpl, toolExecutor: executor }));
  const context: RunContext = {
    companyId,
    taskId: task.id,
    projectId: task.project_id,
    agentId: task.assigned_agent_id,
    runId: "new-run",
    correlationId: task.correlation_id,
    workspacePath: "",
    permissionMode: "restricted",
  };
  return {
    task,
    executor,
    execute,
    fetchImpl,
    context,
    setCall: (call: OpenRouterToolCall) => {
      nextCall = call;
    },
  };
}

async function park() {
  const scenario = setup();
  await orc.drainRunQueue(companyId, { runtimeType: "openrouter" });
  const approval = orc.approvals.listPending(companyId)[0]!;
  expect(approval).toBeTruthy();
  expect(scenario.execute).not.toHaveBeenCalled();
  return { ...scenario, approval };
}

describe("argument-bound runtime tool approvals", () => {
  it("resumes the approved action through the normal quorum/queue flow across an orchestrator restart", async () => {
    const scenario = await park();
    expect(orc.tasks.get(scenario.task.id)?.status).toBe("approval_required");
    expect(scenario.approval.proposed_action).toMatch(/^runtime-tool:v1:[a-f0-9]{64}$/);
    expect(scenario.approval.summary).toContain('"query":"SOP"');
    orc.approvalReviews.setRequiredApprovals(scenario.approval.id, 2);
    expect(
      orc.reviewApproval(companyId, scenario.approval.id, "approved", "Geprüft", { actorId: "owner-a" })?.decided,
    ).toBe(false);
    expect(orc.tasks.get(scenario.task.id)?.status).toBe("approval_required");
    expect(
      orc.reviewApproval(companyId, scenario.approval.id, "approved", "Bestätigt", { actorId: "owner-b" })?.decided,
    ).toBe(true);
    expect(orc.tasks.get(scenario.task.id)?.status).toBe("ready");
    // Key order and the provider's new call ID are not a different action.
    scenario.setCall({ id: "different-model-call-id", name: "memory_search", arguments: { limit: 3, query: "SOP" } });
    const restarted = new CompanyOrchestrator(db);
    restarted.registerRuntime(
      new OpenRouterRuntime({
        apiKey: "offline-fixture-secret",
        fetchImpl: scenario.fetchImpl,
        toolExecutor: restarted.runtimeToolExecutor(companyId),
      }),
    );
    await restarted.drainRunQueue(companyId, { runtimeType: "openrouter" });
    expect(restarted.tasks.get(scenario.task.id)?.status).toBe("review");
    expect(restarted.approvals.listPending(companyId)).toHaveLength(0);
    expect(scenario.fetchImpl).toHaveBeenCalledTimes(3);
    expect(verifyAuditChain(db, companyId).valid).toBe(true);
  });

  it("continues a structured approval request with a receipt, without executing the external action", async () => {
    const scenario = setup();
    const call = {
      id: "call_approval",
      name: "approval_request",
      arguments: { approvalType: "production_deployment", summary: "Geprüften Plan zur Freigabe vorlegen" },
    };
    scenario.setCall(call);
    await orc.drainRunQueue(companyId, { runtimeType: "openrouter" });
    const approval = orc.approvals.listPending(companyId)[0]!;
    expect(approval.approval_type).toBe("production_deployment");
    orc.reviewApproval(companyId, approval.id, "approved");
    await orc.drainRunQueue(companyId, { runtimeType: "openrouter" });
    expect(orc.tasks.get(scenario.task.id)?.status).toBe("review");
    expect(scenario.execute).toHaveBeenCalledTimes(1);
    expect(await scenario.executor.execute(call, scenario.context)).toEqual({
      approvalId: approval.id,
      status: "approved",
      actionExecuted: false,
    });
    expect(orc.approvals.listPending(companyId)).toHaveLength(0);
  });

  it("requires a new decision if arguments change after approval", async () => {
    const scenario = await park();
    orc.reviewApproval(companyId, scenario.approval.id, "approved");
    scenario.setCall({ id: "call_next", name: "memory_search", arguments: { query: "Anderer Kunde", limit: 3 } });
    await orc.drainRunQueue(companyId, { runtimeType: "openrouter" });
    expect(scenario.execute).not.toHaveBeenCalled();
    const next = orc.approvals.listPending(companyId)[0]!;
    expect(next.proposed_action).not.toBe(scenario.approval.proposed_action);
    expect(orc.tasks.get(scenario.task.id)?.status).toBe("approval_required");
  });

  it("does not transfer approval to another task, tool or company", async () => {
    const scenario = await park();
    orc.reviewApproval(companyId, scenario.approval.id, "approved");
    const original = { id: "call", name: "memory_search", arguments: { query: "SOP", limit: 3 } };
    const task2 = orc.tasks.create({
      companyId,
      title: "Other task",
      status: "ready",
      assignedAgentId: scenario.context.agentId!,
    });
    expect(await scenario.executor.authorize(original, { ...scenario.context, taskId: task2.id })).toMatchObject({
      status: "approval_required",
    });
    expect(
      await scenario.executor.authorize(
        { id: "call", name: "task_read", arguments: { taskId: scenario.task.id } },
        scenario.context,
      ),
    ).toMatchObject({ status: "approval_required" });
    await expect(scenario.executor.authorize(original, { ...scenario.context, companyId: "foreign" })).rejects.toThrow(
      /Scope/,
    );
  });

  it("still refuses a disabled grant and an expired or rejected action", async () => {
    const scenario = await park();
    orc.reviewApproval(companyId, scenario.approval.id, "approved");
    const call = { id: "call", name: "memory_search", arguments: { query: "SOP", limit: 3 } };
    db.prepare("UPDATE crew_approvals SET expires_at = ? WHERE id = ?").run(Date.now() - 1, scenario.approval.id);
    expect(await scenario.executor.authorize(call, scenario.context)).toMatchObject({ status: "approval_required" });
    db.prepare("UPDATE crew_approvals SET status = 'rejected' WHERE id = ?").run(scenario.approval.id);
    expect(await scenario.executor.authorize(call, scenario.context)).toMatchObject({ status: "denied" });
    orc.tools.setEnabled(orc.tools.byKey(companyId, "memory.search")!.id, false);
    expect(await scenario.executor.authorize(call, scenario.context)).toMatchObject({ status: "denied" });
  });

  it("filters memory tools by current task and known sensitivity, including changed vault frontmatter", async () => {
    const scenario = setup();
    orc.tools.grant({
      toolId: orc.tools.byKey(companyId, "memory.search")!.id,
      agentId: scenario.context.agentId!,
      requiresApproval: false,
    });
    const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), "crew-tool-memory-"));
    vaults.push(vaultPath);
    const provider = new ObsidianProvider({ vaultPath });
    orc.registerMemoryProvider(provider);
    const other = orc.tasks.create({ companyId, title: "Other", assignedAgentId: scenario.context.agentId });
    async function write(title: string, sensitivity: string, taskId: string | null = null) {
      const entry = await provider.write({
        kind: "note",
        title,
        content: "SOP fixture-secret-value",
        provenance: { companyId, sensitivity, taskId },
      });
      orc.memories.create({
        companyId,
        provider: provider.kind,
        externalId: entry.externalId,
        kind: "note",
        title,
        sensitivity,
        taskId,
      });
      return entry;
    }
    await write("Allowed", "internal", scenario.task.id);
    await write("Confidential", "confidential");
    await write("Other task", "internal", other.id);
    await write("Unknown", "unclassified");
    const changed = await write("Changed locally", "internal");
    const file = path.join(vaultPath, changed.path!);
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("sensitivity: internal", "sensitivity: confidential"));
    const call = { id: "memory-call", name: "memory_search", arguments: { query: "SOP", limit: 20 } };
    const context = { ...scenario.context, redactValues: ["fixture-secret-value"] };
    const results = (await scenario.executor.execute(call, context)) as Array<{ title: string; snippet: string }>;
    expect(results.map((hit) => hit.title)).toEqual(["Allowed"]);
    expect(JSON.stringify(results)).not.toContain("fixture-secret-value");
    db.prepare("UPDATE crew_tasks SET sensitive = 1 WHERE id = ?").run(scenario.task.id);
    const sensitive = (await scenario.executor.execute(call, context)) as Array<{ title: string }>;
    expect(sensitive.map((hit) => hit.title).sort()).toEqual(["Allowed", "Changed locally", "Confidential"]);
  });

  it("binds nested canonical arguments and never stores their plaintext in the fingerprint", () => {
    const { context } = setup();
    const a = toolApprovalBinding(context, "memory.search", { scope: { b: 2, a: "fixture-secret" }, list: [1, 2] });
    expect(a).toBe(
      toolApprovalBinding(context, "memory.search", { list: [1, 2], scope: { a: "fixture-secret", b: 2 } }),
    );
    expect(a).not.toContain("fixture-secret");
    expect(a).not.toBe(
      toolApprovalBinding({ ...context, projectId: "other" }, "memory.search", {
        scope: { b: 2, a: "fixture-secret" },
        list: [1, 2],
      }),
    );
  });
});
