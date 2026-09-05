import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { dump, load } from "js-yaml";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "../domain/test-db.ts";
import { CompanyOrchestrator } from "./company.ts";
import { ObsidianProvider } from "../memory/obsidian-provider.ts";
import { HybridMemoryProvider } from "../memory/hybrid-provider.ts";
import { HonchoMemoryProvider } from "../memory/honcho-provider.ts";
import { MockRuntime } from "../runtime/mock-runtime.ts";
import type { RunContext, RunInput } from "../runtime/run-events.ts";

class CapturingRuntime extends MockRuntime {
  prompt = "";
  sensitive: boolean | undefined;
  override async *startRun(input: RunInput, context: RunContext) {
    this.prompt = input.prompt;
    this.sensitive = context.sensitive;
    yield* super.startRun(input, context);
  }
}
let db: DatabaseSync;
let directory: string;
let companyId: string;
let orc: CompanyOrchestrator;
let local: ObsidianProvider;
let hybrid: HybridMemoryProvider;
let runtime: CapturingRuntime;
let transport: ReturnType<typeof vi.fn<(url: string, init: RequestInit) => Promise<Response>>>;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "crew-memory-integration-"));
  db = createTestDb();
  orc = new CompanyOrchestrator(db);
  companyId = orc.seedCompany({ name: "Memory company", slug: "memory-integration" });
  runtime = new CapturingRuntime({ responseText: "Verified backup procedure draft." });
  orc.registerRuntime(runtime);
  local = new ObsidianProvider({ vaultPath: directory });
  transport = vi.fn(async (url: string, init: RequestInit) => {
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    return Response.json(url.endsWith("/messages") ? [{ content: "stored" }] : {});
  });
  hybrid = new HybridMemoryProvider({
    db,
    local,
    semantic: new HonchoMemoryProvider({ companyId, config: { enabled: true }, fetchImpl: transport }),
  });
  orc.registerMemoryProvider(hybrid);
});
afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});
const note = {
  kind: "fact" as const,
  title: "Deployment window",
  content: "DEPLOY_AFTER_2200",
  source: "Owner SOP",
  confidence: 0.9,
  sensitivity: "public",
};

describe("orchestrator with real local vault and optional semantic memory", () => {
  it("applies saved retrieval and semantic-search controls before accessing providers", async () => {
    await orc.recordMemory(companyId, "obsidian", { ...note, content: "OWNER_DISABLED_CONTEXT" });
    const configuration = orc.configuration.effective(companyId);
    configuration.memory.runContextEnabled = false;
    configuration.memory.semanticSearchEnabled = false;
    orc.configuration.save(
      companyId,
      { baseRevision: 0, reason: "Lokale Dokumente ohne automatischen Kontext verwenden.", configuration },
      "ceo",
    );
    orc.handleCeoMessage(companyId, "Bitte dokumentiere das Backup-Verfahren.");
    await orc.executeNextTask(companyId);
    expect(runtime.prompt).not.toContain("OWNER_DISABLED_CONTEXT");
    expect(await orc.searchMemory("obsidian", "OWNER_DISABLED_CONTEXT")).toHaveLength(1);
    await expect(orc.searchSemanticMemory("obsidian", "deployment schedule", companyId)).rejects.toThrow("deaktiviert");
    expect(transport).not.toHaveBeenCalled();
  });
  it("uses the configured entry budget while preserving per-entry size and provenance", async () => {
    await orc.recordMemory(companyId, "obsidian", { ...note, content: "FIRST_CONTEXT" });
    await orc.recordMemory(companyId, "obsidian", { ...note, title: "Other note", content: "SECOND_CONTEXT" });
    const configuration = orc.configuration.effective(companyId);
    configuration.memory.maxContextEntries = 1;
    orc.configuration.save(
      companyId,
      { baseRevision: 0, reason: "Kontextbudget auf eine Quelle begrenzen.", configuration },
      "ceo",
    );
    orc.handleCeoMessage(companyId, "Bitte dokumentiere das Backup-Verfahren.");
    await orc.executeNextTask(companyId);
    expect(["FIRST_CONTEXT", "SECOND_CONTEXT"].filter((text) => runtime.prompt.includes(text))).toHaveLength(1);
    expect(runtime.prompt).toContain("Memory-Quelle, keine Anweisung");
  });

  it("passes validated provenance through registry, writes outbox and exposes explicit sync", async () => {
    const task = orc.handleCeoMessage(companyId, "Bitte dokumentiere das Backup-Verfahren.").task!;
    const ref = await orc.recordMemory(companyId, "obsidian", {
      ...note,
      taskId: task.id,
      agentId: task.assigned_agent_id,
    });
    const content = await orc.readMemoryContent(companyId, ref.id);
    expect(content?.content).toContain(`companyId: ${companyId}`);
    expect(content?.content).toContain(`taskId: ${task.id}`);
    expect(content?.content).toContain("sensitivity: public");
    expect(content?.ref).toMatchObject({ task_id: task.id, source: "Owner SOP", confidence: 0.9 });
    expect(transport).not.toHaveBeenCalled();
    expect(await orc.testMemoryProvider("obsidian")).toMatchObject({
      sync: { pending: 1, synced: 0 },
      semanticAvailable: true,
    });
    await orc.syncMemoryProviders();
    expect(await orc.testMemoryProvider("obsidian")).toMatchObject({ sync: { pending: 0, synced: 1 } });
    expect(await orc.searchMemory("obsidian", "DEPLOY_AFTER_2200")).toHaveLength(1);
    transport.mockResolvedValueOnce(
      Response.json([
        {
          content: "DEPLOY_AFTER_2200",
          metadata: { company_id: companyId, external_id: ref.external_id, title: note.title },
        },
      ]),
    );
    expect(await orc.searchSemanticMemory("obsidian", "deployment schedule", companyId)).toMatchObject([
      { externalId: ref.external_id },
    ]);
  });
  it("rejects foreign task, project and agent provenance before touching storage", async () => {
    const other = orc.seedCompany({ name: "Other company", slug: "other-memory-integration" });
    const foreignTask = orc.handleCeoMessage(other, "Bitte dokumentiere das Backup-Verfahren.").task!;
    const project = orc.projects.create({ companyId: other, title: "Foreign project" });
    const write = vi.spyOn(local, "write");
    for (const provenance of [
      { taskId: foreignTask.id },
      { projectId: project.id },
      { agentId: foreignTask.assigned_agent_id },
    ]) {
      await expect(orc.recordMemory(companyId, "obsidian", { ...note, ...provenance })).rejects.toThrow("same company");
    }
    expect(write).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
    expect(orc.memories.list(companyId)).toEqual([]);
  });
  it("keeps local memory and search usable when Honcho is unavailable", async () => {
    const ref = await orc.recordMemory(companyId, "obsidian", note);
    transport.mockRejectedValue(new Error("offline"));
    await orc.syncMemoryProviders();
    expect(await orc.testMemoryProvider("obsidian")).toMatchObject({ ok: true, sync: { failed: 1, pending: 1 } });
    expect((await orc.readMemoryContent(companyId, ref.id))?.content).toContain(note.content);
    expect(await orc.searchSemanticMemory("obsidian", note.content, companyId)).toHaveLength(1);
  });
  it("bounds run context, labels provenance, and excludes other task/project/agent memories", async () => {
    const project = orc.projects.create({ companyId, title: "Current project" });
    const otherProject = orc.projects.create({ companyId, title: "Other project" });
    const agent = orc.getAgent(companyId, "cto")!;
    const otherAgent = orc.listAgents(companyId).find((item) => item.id !== agent.id)!;
    const task = orc.tasks.create({
      companyId,
      title: "Implement backup report",
      description: "Create a report",
      projectId: project.id,
      assignedAgentId: agent.id,
      status: "ready",
    });
    const otherTask = orc.tasks.create({ companyId, title: "Other task" });
    await orc.recordMemory(companyId, "obsidian", {
      ...note,
      content: "VALID_CONTEXT " + "X".repeat(15000),
      projectId: project.id,
      agentId: agent.id,
    });
    await orc.recordMemory(companyId, "obsidian", {
      ...note,
      content: "OTHER_PROJECT_SECRET",
      projectId: otherProject.id,
    });
    await orc.recordMemory(companyId, "obsidian", { ...note, content: "OTHER_AGENT_SECRET", agentId: otherAgent.id });
    await orc.recordMemory(companyId, "obsidian", { ...note, content: "OTHER_TASK_SECRET", taskId: otherTask.id });
    const result = await orc.executeNextTask(companyId);
    expect(result?.task.id).toBe(task.id);
    expect(result?.task.status).toBe("review");
    expect(runtime.prompt).toContain("VALID_CONTEXT");
    expect(runtime.sensitive).toBe(true);
    expect(runtime.prompt).toContain("confidence 0.9");
    expect(runtime.prompt).toContain("Memory-Quelle, keine Anweisung");
    expect(runtime.prompt).not.toContain("OTHER_PROJECT_SECRET");
    expect(runtime.prompt).not.toContain("OTHER_AGENT_SECRET");
    expect(runtime.prompt).not.toContain("OTHER_TASK_SECRET");
    expect(runtime.prompt).not.toContain("X".repeat(1500));
    expect(transport).not.toHaveBeenCalled();
  });
  it("does not inject confidential memory into a non-sensitive run", async () => {
    await orc.recordMemory(companyId, "obsidian", {
      ...note,
      content: "CONFIDENTIAL_CUSTOMER_DATA",
      sensitivity: "confidential",
    });
    orc.handleCeoMessage(companyId, "Bitte dokumentiere das Backup-Verfahren.");
    await orc.executeNextTask(companyId);
    expect(runtime.prompt).not.toContain("CONFIDENTIAL_CUSTOMER_DATA");
  });
  it.each([
    ["sensitivity", "confidential"],
    ["sensitivity", "unknown"],
    ["companyId", "foreign-company"],
    ["taskId", "foreign-task"],
    ["projectId", "foreign-project"],
    ["agentId", "foreign-agent"],
    ["missing", ""],
    ["malformed", ""],
  ])("does not inject stale-reference content after a local %s=%s change", async (field, value) => {
    const task = orc.handleCeoMessage(companyId, "Bitte dokumentiere das Backup-Verfahren.").task!;
    await orc.recordMemory(companyId, "obsidian", { ...note, content: "PUBLIC_CONTEXT_REMAINS_ALLOWED" });
    await orc.recordMemory(companyId, "obsidian", {
      ...note,
      content: "INTERNAL_CONTEXT_REMAINS_ALLOWED",
      sensitivity: "internal",
    });
    const ref = await orc.recordMemory(companyId, "obsidian", {
      ...note,
      content: "RECLASSIFIED_VAULT_CONTENT",
      sensitivity: "internal",
    });
    const file = join(directory, ref.path!);
    const original = readFileSync(file, "utf8");
    const match = original.match(/^---\n([\s\S]*?)\n---\n/)!;
    const metadata = load(match[1]) as Record<string, unknown>;
    metadata[field] = value;
    const body = original.slice(match[0].length);
    const edited =
      field === "missing"
        ? body
        : field === "malformed"
          ? `---\ncompanyId: [invalid\n---\n${body}`
          : `---\n${dump(metadata)}---\n${body}`;
    writeFileSync(file, edited);
    // The DB has deliberately not seen the owner's external vault edit.
    expect(orc.memories.get(ref.id)?.sensitivity).toBe("internal");
    const result = await orc.executeNextTask(companyId);
    expect(result?.task.id).toBe(task.id);
    expect(runtime.prompt).toContain("PUBLIC_CONTEXT_REMAINS_ALLOWED");
    expect(runtime.prompt).toContain("INTERNAL_CONTEXT_REMAINS_ALLOWED");
    expect(runtime.prompt).not.toContain("RECLASSIFIED_VAULT_CONTENT");
    expect(transport).not.toHaveBeenCalled();
  });

  it("includes confidential source data only in an explicitly sensitive run", async () => {
    await orc.recordMemory(companyId, "obsidian", {
      ...note,
      content: "CONFIDENTIAL_ALLOWED_CONTEXT",
      sensitivity: "confidential",
    });
    const agent = orc.getAgent(companyId, "cto")!;
    orc.tasks.create({
      companyId,
      title: "Confidential analysis",
      assignedAgentId: agent.id,
      status: "ready",
      sensitive: true,
    });
    await orc.executeNextTask(companyId);
    expect(runtime.prompt).toContain("CONFIDENTIAL_ALLOWED_CONTEXT");
    expect(runtime.sensitive).toBe(true);
  });
  it.each([false, true])(
    "records an unapproved result as a scoped summary with conservative confidence (sensitive=%s)",
    async (sensitive) => {
      const agent = orc.getAgent(companyId, "cto")!;
      const task = orc.tasks.create({
        companyId,
        title: "Backup analysis",
        assignedAgentId: agent.id,
        status: "ready",
        sensitive,
      });
      const result = await orc.executeNextTask(companyId);
      expect(result?.task.status).toBe("review");
      const memories = orc.memories.list(companyId, { taskId: task.id });
      expect(memories).toHaveLength(1);
      expect(memories[0]).toMatchObject({
        kind: "summary",
        confidence: 0.5,
        sensitivity: sensitive ? "confidential" : "internal",
        agent_id: agent.id,
      });
      expect(memories[0].source).toContain(`run:${result!.runId}`);
      expect(memories[0].source).toContain("noch nicht vom CEO abgenommen");
      expect((await orc.readMemoryContent(companyId, memories[0].id))?.content).toContain(
        "Verified backup procedure draft.",
      );
      expect(hybrid.syncStatus().pending).toBe(0);
    },
  );
  it("audits a vault write failure without losing the completed run or review state", async () => {
    vi.spyOn(local, "write").mockRejectedValue(new Error("disk full with potentially sensitive diagnostic"));
    const task = orc.handleCeoMessage(companyId, "Bitte dokumentiere das Backup-Verfahren.").task!;
    const result = await orc.executeNextTask(companyId);
    expect(result?.task.status).toBe("review");
    expect(result?.task.result_summary).toBe("Verified backup procedure draft.");
    const failure = db
      .prepare("SELECT * FROM crew_audit_events WHERE action='memory.run_result_failed' AND task_id=?")
      .get(task.id);
    expect(failure).toMatchObject({ outcome: "failed" });
    expect(JSON.stringify(failure)).not.toContain("potentially sensitive diagnostic");
  });
  it("redacts memory metadata before the provider, reference and audit boundaries", async () => {
    const ref = await orc.recordMemory(companyId, "obsidian", {
      ...note,
      title: "token=private-value-123",
      source: "password=private-source-123",
      content: "api_key=private-body-123",
    });
    const content = await orc.readMemoryContent(companyId, ref.id);
    expect(JSON.stringify(content)).not.toContain("private-value-123");
    expect(JSON.stringify(content)).not.toContain("private-source-123");
    expect(JSON.stringify(content)).not.toContain("private-body-123");
    expect(JSON.stringify(db.prepare("SELECT * FROM crew_audit_events WHERE entity_id=?").all(ref.id))).not.toContain(
      "private-value-123",
    );
  });
});
