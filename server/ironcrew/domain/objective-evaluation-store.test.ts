import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestDb, seedCompany, seedAgent } from "./test-db.ts";
import { TaskStore } from "./task-store.ts";
import { RunStore } from "../runtime/run-store.ts";
import { ObjectiveEvaluationStore } from "./objective-evaluation-store.ts";
import { verifyAuditChain } from "./audit.ts";
import { UserStore } from "../auth/user-store.ts";
let db: DatabaseSync;
let company: string;
let agent: string;
let store: ObjectiveEvaluationStore;
const owner = { actorType: "owner" as const, actorId: "ceo" };
const rubricInput = (patch: Record<string, unknown> = {}) => ({
  key: "answer-quality",
  baseVersion: 0,
  title: "Strukturierte Antwort",
  reason: "Abnahmekriterien vorab festlegen.",
  cases: [
    { id: "contains", label: "Quelle enthalten", kind: "contains", expected: "Quelle" },
    { id: "excludes", label: "Keine Unsicherheit verschweigen", kind: "excludes", expected: "garantiert fehlerfrei" },
    { id: "shape", label: "Resultat ist Text", kind: "json_field", path: ["result"], valueType: "string" },
  ],
  ...patch,
});
function evidence(
  text = '{"result":"Quelle geprüft"}',
  foreignCompany = company,
  foreignAgent = agent,
  status = "completed",
) {
  const task = new TaskStore(db).create({ companyId: foreignCompany, title: "Quellenbericht", status: "ready" });
  const runs = new RunStore(db);
  const run = runs.create({
    companyId: foreignCompany,
    taskId: task.id,
    agentId: foreignAgent,
    runtimeType: "mock",
    model: "test-model",
  });
  runs.setStatus(run.id, status);
  db.prepare(
    "INSERT INTO crew_run_events(id,company_id,run_id,task_id,agent_id,seq,type,payload_json) VALUES(?,?,?,?,?,1,'message.completed',?)",
  ).run(`event-${run.id}`, foreignCompany, run.id, task.id, foreignAgent, JSON.stringify({ text }));
  return run;
}
beforeEach(() => {
  db = createTestDb();
  company = seedCompany(db);
  agent = seedAgent(db, company);
  store = new ObjectiveEvaluationStore(db);
});
afterEach(() => db.close());
describe("objective evidence evaluations", () => {
  it("preserves criteria, evidence, comparison and replay across a database restart", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "crew-objective-"));
    const filename = path.join(directory, "crew.sqlite");
    db.close();
    db = createTestDb(filename);
    company = seedCompany(db);
    agent = seedAgent(db, company);
    store = new ObjectiveEvaluationStore(db);
    try {
      const rubric = store.createRubric(company, rubricInput(), owner);
      const run = evidence();
      const result = store.measure(company, { rubricId: rubric.id, runId: run.id }, owner);
      db.close();
      db = new DatabaseSync(filename);
      store = new ObjectiveEvaluationStore(db);
      expect(store.snapshot(company, owner)).toMatchObject({
        rubrics: [{ id: rubric.id }],
        measurements: [{ id: result.id }],
        comparisons: [{ runCount: 1 }],
      });
      expect(store.replay(company, result.id)).toEqual(result.checks);
      expect(verifyAuditChain(db, company).valid).toBe(true);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  it("persists immutable versioned criteria, deterministic per-case results and idempotent comparisons", () => {
    const rubric = store.createRubric(company, rubricInput(), owner);
    const run = evidence();
    const result = store.measure(company, { rubricId: rubric.id, runId: run.id }, owner);
    expect(result).toMatchObject({
      score: 100,
      passedCases: 3,
      totalCases: 3,
      engineVersion: 1,
      run: { id: run.id, taskId: run.task_id, agentId: agent, runtimeType: "mock", model: "test-model" },
    });
    expect(result.evidenceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(store.replay(company, result.id)).toEqual(result.checks);
    expect(store.measure(company, { rubricId: rubric.id, runId: run.id }, owner)).toEqual(result);
    expect(store.snapshot(company, owner).comparisons).toMatchObject([
      { rubricId: rubric.id, runCount: 1, score: 100 },
    ]);
    expect(() => db.prepare("UPDATE crew_objective_rubrics SET version=2 WHERE id=?").run(rubric.id)).toThrow(
      "immutable",
    );
    expect(() => db.prepare("DELETE FROM crew_objective_measurements WHERE id=?").run(result.id)).toThrow("immutable");
    expect(verifyAuditChain(db, company).valid).toBe(true);
    expect(db.prepare("SELECT action FROM crew_audit_events WHERE action LIKE 'evaluation.%'").all()).toHaveLength(2);
  });
  it("keeps failed checks visible and separates rubric versions rather than averaging incompatible criteria", () => {
    const first = store.createRubric(company, rubricInput(), owner);
    const run = evidence("Quelle garantiert fehlerfrei");
    expect(store.measure(company, { rubricId: first.id, runId: run.id }, owner)).toMatchObject({
      passedCases: 1,
      score: 33.33,
      checks: [{ passed: true }, { passed: false }, { passed: false, observed: "Ergebnis ist kein gültiges JSON." }],
    });
    const second = store.createRubric(
      company,
      rubricInput({ baseVersion: 1, cases: [{ id: "a", label: "Quelle", kind: "contains", expected: "Quelle" }] }),
      owner,
    );
    store.measure(company, { rubricId: second.id, runId: run.id }, owner);
    expect(store.snapshot(company, owner).comparisons).toHaveLength(2);
    expect(() => store.createRubric(company, rubricInput(), owner)).toThrow("inzwischen geändert");
    expect(store.snapshot(company, owner).rubrics.find((r) => r.id === first.id)?.cases).toHaveLength(3);
  });
  it("rejects missing, foreign, nonterminal and inconsistent run evidence", () => {
    const rubric = store.createRubric(company, rubricInput(), owner);
    const otherCompany = seedCompany(db, "Andere Firma");
    const otherAgent = seedAgent(db, otherCompany);
    const foreign = evidence("Quelle", otherCompany, otherAgent);
    expect(() => store.measure(company, { rubricId: rubric.id, runId: foreign.id }, owner)).toThrow("dieser Firma");
    const own = evidence();
    expect(() => store.measure(otherCompany, { rubricId: rubric.id, runId: own.id }, owner)).toThrow(
      "Rubrik nicht gefunden",
    );
    for (const status of ["running", "failed", "cancelled", "rate_limited", "waiting"]) {
      const pending = evidence("Quelle", company, agent, status);
      expect(() => store.measure(company, { rubricId: rubric.id, runId: pending.id }, owner)).toThrow(
        "abgeschlossene Runs",
      );
    }
    db.prepare("UPDATE crew_run_events SET agent_id=? WHERE run_id=?").run(otherAgent, own.id);
    expect(() => store.measure(company, { rubricId: rubric.id, runId: own.id }, owner)).toThrow(
      "Widersprüchliche Zuordnung",
    );
    db.prepare("DELETE FROM crew_run_events WHERE run_id=?").run(own.id);
    expect(() => store.measure(company, { rubricId: rubric.id, runId: own.id }, owner)).toThrow("kein gespeichertes");
  });
  it("replays preserved evidence after source changes without letting repeat measurements inflate sample counts", () => {
    const rubric = store.createRubric(company, rubricInput(), owner);
    const run = evidence();
    const result = store.measure(company, { rubricId: rubric.id, runId: run.id }, owner);
    db.prepare("UPDATE crew_agents SET display_name=? WHERE id=?").run("Neuer Anzeigename", agent);
    db.prepare("UPDATE crew_tasks SET title=? WHERE id=?").run("Präzisierter Aufgabentitel", run.task_id);
    expect(store.measure(company, { rubricId: rubric.id, runId: run.id }, owner)).toEqual(result);
    expect(store.replay(company, result.id)).toEqual(result.checks);
    db.prepare("UPDATE crew_run_events SET payload_json=? WHERE run_id=?").run(
      JSON.stringify({ text: "changed" }),
      run.id,
    );
    expect(() => store.measure(company, { rubricId: rubric.id, runId: run.id }, owner)).toThrow("Nachweis hat sich");
    expect(store.replay(company, result.id)).toEqual(result.checks);
    expect(store.snapshot(company, owner).comparisons[0].runCount).toBe(1);
  });
  it("bounds inputs and rejects arbitrary code, duplicated checks, prototype paths and injected scores", () => {
    for (const patch of [
      { score: 100 },
      { companyId: company },
      { cases: [{ id: "x", label: "x", kind: "code", expected: "process.exit()" }] },
      { cases: [{ id: "x", label: "x", kind: "json_field", path: ["__proto__"], valueType: "object" }] },
      { cases: Array.from({ length: 31 }, () => ({ id: "same", label: "x", kind: "contains", expected: "x" })) },
    ]) {
      expect(() => store.createRubric(company, rubricInput(patch), owner)).toThrow();
    }
    const rubric = store.createRubric(company, rubricInput(), owner);
    const run = evidence("a".repeat(2_000_001));
    expect(() => store.measure(company, { rubricId: rubric.id, runId: run.id }, owner)).toThrow("Auswertungslimit");
    expect(() => store.measure(company, { rubricId: rubric.id, runId: run.id, score: 100 }, owner)).toThrow();
  });
  it("does not persist secret assertions or expose raw output in snapshots", () => {
    const secret = "sk-" + "a".repeat(48);
    expect(() =>
      store.createRubric(
        company,
        rubricInput({ cases: [{ id: "secret", label: "Schlüssel", kind: "contains", expected: secret }] }),
        owner,
      ),
    ).toThrow("Secrets");
    const rubric = store.createRubric(company, rubricInput(), owner);
    const run = evidence(`Quelle ${secret}`);
    store.measure(company, { rubricId: rubric.id, runId: run.id }, owner);
    expect(JSON.stringify(store.snapshot(company, owner))).not.toContain(secret);
    const row = db.prepare("SELECT evidence_json FROM crew_objective_measurements").get() as { evidence_json: string };
    expect(row.evidence_json).not.toContain(secret);
  });
  it("requires owner rubric edits and operator measurement permissions without changing stars or career levels", async () => {
    const users = new UserStore(db);
    const realOwner = await users.create({
      email: "owner@example.invalid",
      password: "testing-password",
      role: "owner",
    });
    const operator = await users.create({
      email: "operator@example.invalid",
      password: "testing-password",
      role: "operator",
    });
    const viewer = await users.create({
      email: "viewer@example.invalid",
      password: "testing-password",
      role: "viewer",
    });
    expect(() => store.createRubric(company, rubricInput(), owner)).toThrow("Berechtigung");
    expect(() => store.createRubric(company, rubricInput(), { ...owner, actorId: operator.id })).toThrow(
      "Berechtigung",
    );
    const rubric = store.createRubric(company, rubricInput(), { ...owner, actorId: realOwner.id });
    const run = evidence();
    expect(() =>
      store.measure(company, { rubricId: rubric.id, runId: run.id }, { ...owner, actorId: viewer.id }),
    ).toThrow("Berechtigung");
    store.measure(company, { rubricId: rubric.id, runId: run.id }, { ...owner, actorId: operator.id });
    expect(store.snapshot(company, { ...owner, actorId: viewer.id })).toMatchObject({
      canEdit: false,
      canMeasure: false,
    });
    expect(db.prepare("SELECT * FROM crew_career_reviews").all()).toHaveLength(0);
    expect(db.prepare("SELECT * FROM crew_career_levels").all()).toHaveLength(0);
  });
});
