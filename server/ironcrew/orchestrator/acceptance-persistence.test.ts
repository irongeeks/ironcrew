import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { createTestDb } from "../domain/test-db.ts";
import { verifyAuditChain } from "../domain/audit.ts";
import { configDir, loadCrewConfig, loadDepartmentConfig } from "../domain/crew-config.ts";
import { ObsidianProvider } from "../memory/obsidian-provider.ts";
import { MockRuntime } from "../runtime/mock-runtime.ts";
import type { RunContext, RunInput } from "../runtime/run-events.ts";
import { CompanyOrchestrator } from "./company.ts";

class RevisionRuntime extends MockRuntime {
  readonly prompts: string[] = [];
  override async *startRun(input: RunInput, context: RunContext) {
    this.prompts.push(input.prompt);
    yield* super.startRun(input, context);
  }
}

it("retains CEO revision, both actual runs, vault sources and acceptance after real database close/reopen", async () => {
  const directory = mkdtempSync(join(tmpdir(), "crew-acceptance-"));
  const file = join(directory, "company.sqlite");
  const vault = join(directory, "vault");
  let db = createTestDb(file);
  try {
    let company = new CompanyOrchestrator(db);
    const companyId = company.seedCompany({
      name: "Acceptance company",
      slug: "acceptance",
      crew: loadCrewConfig(undefined, join(configDir(), "private", "__missing__.yaml")),
      departments: loadDepartmentConfig(),
    });
    company.registerMemoryProvider(new ObsidianProvider({ vaultPath: vault }));
    company.registerRuntime(new MockRuntime({ responseText: "Erster dokumentierter Backup-Entwurf." }));
    const task = company.handleCeoMessage(companyId, "Bitte dokumentiere unser Backup-Verfahren.").task!;
    expect(await company.drainRunQueue(companyId)).toMatchObject({ completed: 1, failed: 0 });
    const firstRun = company.runs.listForTask(task.id)[0];
    expect(company.tasks.get(task.id)?.status).toBe("review");
    const revision = "Bitte ergänze die Wiederherstellung und überprüfbare Abnahmekriterien.";
    expect(company.requestRevision(companyId, task.id, revision)?.status).toBe("ready");

    // Reopen SQLite itself, not just the service around the same connection.
    db.close();
    db = new DatabaseSync(file);
    db.exec("PRAGMA foreign_keys = ON");
    company = new CompanyOrchestrator(db);
    company.registerMemoryProvider(new ObsidianProvider({ vaultPath: vault }));
    const revisedRuntime = new RevisionRuntime({ responseText: "Überarbeitung mit Restore und Abnahmekriterien." });
    company.registerRuntime(revisedRuntime);
    expect(company.tasks.get(task.id)?.review_notes).toBe(revision);
    expect(await company.drainRunQueue(companyId)).toMatchObject({ completed: 1, failed: 0 });
    expect(revisedRuntime.prompts).toHaveLength(1);
    expect(revisedRuntime.prompts[0]).toContain(revision);
    expect(company.tasks.get(task.id)?.status).toBe("review");
    const runs = company.runs.listForTask(task.id);
    expect(runs).toHaveLength(2);
    expect(new Set(runs.map((run) => run.id)).size).toBe(2);
    expect(runs.some((run) => run.id === firstRun.id)).toBe(true);
    for (const run of runs) {
      expect(run.status).toBe("completed");
      expect(run.correlation_id).toBe(task.correlation_id);
      const events = company.runs.listEvents(run.id);
      expect(events[0].type).toBe("run.started");
      expect(events.at(-1)?.type).toBe("run.completed");
    }
    expect(company.acceptReview(companyId, task.id, "Restore ergänzt und geprüft.")?.status).toBe("done");

    db.close();
    db = new DatabaseSync(file);
    company = new CompanyOrchestrator(db);
    company.registerMemoryProvider(new ObsidianProvider({ vaultPath: vault }));
    expect(company.tasks.get(task.id)).toMatchObject({
      status: "done",
      result_summary: "Überarbeitung mit Restore und Abnahmekriterien.",
    });
    expect(company.runs.listForTask(task.id)).toHaveLength(2);
    const memories = company.memories.list(companyId, { taskId: task.id });
    expect(memories).toHaveLength(2);
    for (const run of runs) {
      const memory = memories.find((entry) => entry.source.includes(`run:${run.id}`))!;
      expect(memory).toBeDefined();
      expect((await company.readMemoryContent(companyId, memory.id))?.content).toContain(`taskId: ${task.id}`);
    }
    const messages = db.prepare("SELECT body FROM crew_messages WHERE task_id = ?").all(task.id);
    expect(JSON.stringify(messages)).toContain(revision);
    expect(JSON.stringify(messages)).toContain("Abgenommen");
    expect(verifyAuditChain(db, companyId).valid).toBe(true);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);
