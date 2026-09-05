import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createTestDb, seedAgent, seedCompany } from "./test-db.ts";
import { CoachingStore } from "./coaching-store.ts";
import { TaskStore } from "./task-store.ts";
import { RunStore } from "../runtime/run-store.ts";
import { UserStore } from "../auth/user-store.ts";
import { verifyAuditChain } from "./audit.ts";

const owner = { actorType: "owner" as const, actorId: "ceo" };
let db: DatabaseSync;
let store: CoachingStore;
let companyId: string;
let agentId: string;
let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "crew-coaching-"));
  db = createTestDb(path.join(dir, "crew.sqlite"));
  companyId = seedCompany(db);
  agentId = seedAgent(db, companyId);
  store = new CoachingStore(db);
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
const proposal = (patch: Record<string, unknown> = {}) => ({
  agentId,
  title: "Quellen im Review",
  guidance: "Nenne Quellen und trenne Hypothesen von Fakten.",
  skills: [],
  cases: [{ label: "Quellenanforderung", kind: "guidance_contains", expected: "Quellen" }],
  ...patch,
});
function run(status = "completed", runCompany = companyId, runAgent = agentId) {
  const task = new TaskStore(db).create({ companyId: runCompany, title: "Research evidence", status: "ready" });
  const runs = new RunStore(db);
  const r = runs.create({ companyId: runCompany, taskId: task.id, agentId: runAgent, runtimeType: "mock" });
  runs.setStatus(r.id, status);
  db.prepare(
    "INSERT INTO crew_run_events (id,company_id,run_id,task_id,agent_id,seq,type,payload_json) VALUES (?,?,?,?,?,1,'message.completed',?)",
  ).run(
    `evt-${r.id}`,
    runCompany,
    r.id,
    task.id,
    runAgent,
    JSON.stringify({ text: "Quellen: interne Betriebsdokumentation. Akzeptanzkriterien erfüllt." }),
  );
  runs.addUsage(r.id, 120, 45, 200);
  return r;
}
describe("human reviewed coaching", () => {
  it("persists draft, deterministic run evidence, owner review and an isolated version across restart", () => {
    const colleague = seedAgent(db, companyId, "colleague");
    const talents = db.prepare("SELECT * FROM crew_talents ORDER BY id").all();
    const evidence = run();
    const draft = store.create(
      companyId,
      proposal({
        cases: [
          { label: "Quellen im Ergebnis", kind: "run_output_contains", expected: "Quellen", runId: evidence.id },
          { label: "Ergebnis abgeschlossen", kind: "run_succeeded", runId: evidence.id },
          { label: "Guidance nennt Quellen", kind: "guidance_contains", expected: "Quellen" },
        ],
      }),
      owner,
    );
    expect(draft.status).toBe("draft");
    expect(store.current(companyId, agentId)).toBeNull();
    const evaluated = store.evaluate(companyId, draft.id, owner);
    expect(evaluated.evaluation).toMatchObject({ passed: true, passedCases: 3, totalCases: 3 });
    expect(evaluated.evaluation?.checks[0]).toMatchObject({
      runId: evidence.id,
      evidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(evaluated.evaluation?.checks[0].observed).toContain("120 Eingabe-/ 45 Ausgabetoken");
    store.review(companyId, draft.id, { decision: "approve", reason: "Quellenregel und Nachweise geprüft." }, owner);
    expect(store.current(companyId, agentId)).toMatchObject({
      version: 1,
      guidance: proposal().guidance,
      approvedBy: "ceo",
    });
    expect(store.current(companyId, colleague)).toBeNull();
    expect(db.prepare("SELECT * FROM crew_talents ORDER BY id").all()).toEqual(talents);
    db.close();
    db = new DatabaseSync(path.join(dir, "crew.sqlite"));
    store = new CoachingStore(db);
    expect(store.snapshot(companyId, agentId)).toMatchObject({
      current: { version: 1 },
      proposals: [{ status: "applied", reviewedBy: "ceo", evaluation: { passedCases: 3 } }],
    });
    expect(verifyAuditChain(db, companyId).valid).toBe(true);
    const audits = db
      .prepare("SELECT action,correlation_id FROM crew_audit_events WHERE action LIKE 'coaching.%' ORDER BY seq")
      .all() as { action: string; correlation_id: string }[];
    expect(audits.map((a) => a.action)).toEqual(["coaching.proposed", "coaching.evaluated", "coaching.applied"]);
    expect(new Set(audits.map((a) => a.correlation_id)).size).toBe(1);
  });
  it("refuses approval before evaluation and after a failed quality gate", () => {
    const draft = store.create(
      companyId,
      proposal({ cases: [{ label: "Fehlendes Kriterium", kind: "guidance_contains", expected: "Rollbackplan" }] }),
      owner,
    );
    expect(() => store.review(companyId, draft.id, { decision: "approve", reason: "Freigabe" }, owner)).toThrow(
      "Qualitätsprüfungen",
    );
    expect(store.evaluate(companyId, draft.id, owner)).toMatchObject({
      status: "failed",
      evaluation: { passed: false, passedCases: 0 },
    });
    expect(() => store.review(companyId, draft.id, { decision: "approve", reason: "Trotzdem" }, owner)).toThrow(
      "Qualitätsprüfungen",
    );
    expect(store.current(companyId, agentId)).toBeNull();
    expect(
      store.review(companyId, draft.id, { decision: "reject", reason: "Bitte mit Rollbackplan neu erstellen." }, owner)
        .status,
    ).toBe("rejected");
    expect(() => store.evaluate(companyId, draft.id, owner)).toThrow("abgeschlossen");
  });
  it("cannot change another company's agent or use another agent's run evidence", () => {
    const otherCompany = seedCompany(db, "other");
    const otherAgent = seedAgent(db, otherCompany);
    const foreign = run("completed", otherCompany, otherAgent);
    expect(() => store.create(companyId, proposal({ agentId: otherAgent }), owner)).toThrow("Agent nicht gefunden");
    expect(() =>
      store.create(
        companyId,
        proposal({ cases: [{ label: "foreign", kind: "run_succeeded", runId: foreign.id }] }),
        owner,
      ),
    ).toThrow("Run-Nachweis");
    const draft = store.create(companyId, proposal(), owner);
    expect(() => store.evaluate(otherCompany, draft.id, owner)).toThrow("nicht gefunden");
    expect(() => store.review(otherCompany, draft.id, { decision: "reject", reason: "foreign" }, owner)).toThrow(
      "nicht gefunden",
    );
    expect(store.snapshot(otherCompany, otherAgent).proposals).toEqual([]);
  });
  it("requires an active real owner once identity exists and rejects agent/system approvals", async () => {
    const users = new UserStore(db);
    const human = await users.create({ email: "owner@example.invalid", password: "test-password-only", role: "owner" });
    const operator = await users.create({
      email: "operator@example.invalid",
      password: "test-password-only",
      role: "operator",
    });
    const actor = { actorType: "owner" as const, actorId: operator.id };
    const draft = store.create(companyId, proposal(), actor);
    store.evaluate(companyId, draft.id, actor);
    for (const reviewer of [
      actor,
      owner,
      { actorType: "agent" as const, actorId: agentId },
      { actorType: "system" as const, actorId: "scheduler" },
    ])
      expect(() => store.review(companyId, draft.id, { decision: "approve", reason: "review" }, reviewer)).toThrow();
    store.review(
      companyId,
      draft.id,
      { decision: "approve", reason: "Owner reviewed evidence" },
      { actorType: "owner", actorId: human.id },
    );
    expect(store.current(companyId, agentId)?.approvedBy).toBe(human.id);
  });
  it("fences obsolete proposals and repeated apply without changing the accepted version", () => {
    const a = store.create(companyId, proposal(), owner);
    const b = store.create(companyId, proposal({ guidance: "Quellen vollständig belegen." }), owner);
    store.evaluate(companyId, a.id, owner);
    store.evaluate(companyId, b.id, owner);
    store.review(companyId, a.id, { decision: "approve", reason: "first" }, owner);
    expect(() => store.review(companyId, b.id, { decision: "approve", reason: "stale" }, owner)).toThrow(
      "inzwischen geändert",
    );
    expect(() => store.review(companyId, a.id, { decision: "approve", reason: "repeat" }, owner)).toThrow(
      "bereits entschieden",
    );
    expect(store.snapshot(companyId, agentId).versions).toHaveLength(1);
  });
  it("rechecks evidence at approval and will not accept changed output", () => {
    const evidence = run();
    const draft = store.create(
      companyId,
      proposal({
        cases: [{ label: "Quellen vorhanden", kind: "run_output_contains", expected: "Quellen", runId: evidence.id }],
      }),
      owner,
    );
    store.evaluate(companyId, draft.id, owner);
    db.prepare("UPDATE crew_run_events SET payload_json = ? WHERE run_id = ?").run(
      JSON.stringify({ text: "Quellen: anderer Inhalt" }),
      evidence.id,
    );
    expect(() => store.review(companyId, draft.id, { decision: "approve", reason: "old" }, owner)).toThrow("verändert");
    expect(store.current(companyId, agentId)).toBeNull();
    store.evaluate(companyId, draft.id, owner);
    store.review(companyId, draft.id, { decision: "approve", reason: "new evidence checked" }, owner);
    expect(db.prepare("SELECT * FROM crew_coaching_evaluations WHERE proposal_id = ?").all(draft.id)).toHaveLength(2);
  });
  it("accepts only installed company skill references and detects changed installation provenance", () => {
    expect(() => store.create(companyId, proposal({ skills: ["unknown"] }), owner)).toThrow("nicht installiert");
    db.prepare(
      "INSERT INTO crew_marketplace_installs (id,company_id,entry_id,entry_type,name,version) VALUES ('install',?,'entry','skill','source-check','1')",
    ).run(companyId);
    const draft = store.create(
      companyId,
      proposal({
        skills: ["source-check"],
        cases: [{ label: "Skill", kind: "skill_present", expected: "source-check" }],
      }),
      owner,
    );
    expect(store.evaluate(companyId, draft.id, owner).status).toBe("ready");
    db.prepare("UPDATE crew_marketplace_installs SET version = '2' WHERE id = 'install'").run();
    expect(() => store.review(companyId, draft.id, { decision: "approve", reason: "review" }, owner)).toThrow(
      "Skills wurden geändert",
    );
  });
  it("refuses mutable run evidence and fails cancelled or failed-run status checks", () => {
    const running = run("running");
    expect(() =>
      store.create(
        companyId,
        proposal({ cases: [{ label: "laufend", kind: "run_succeeded", runId: running.id }] }),
        owner,
      ),
    ).toThrow("abgeschlossen");
    for (const status of ["failed", "cancelled"]) {
      const evidence = run(status);
      const draft = store.create(
        companyId,
        proposal({ cases: [{ label: status, kind: "run_succeeded", runId: evidence.id }] }),
        owner,
      );
      expect(store.evaluate(companyId, draft.id, owner).status).toBe("failed");
    }
  });
  it("records one-on-one, retrospectives and lessons with sources without self-modifying guidance", () => {
    const evidence = run();
    for (const kind of ["one_on_one", "retrospective", "lesson"] as const)
      store.note(
        companyId,
        { agentId, kind, title: kind, body: "Nächstes Mal Quellen prüfen.", runId: evidence.id },
        owner,
      );
    expect(store.snapshot(companyId, agentId).notes).toHaveLength(3);
    expect(store.current(companyId, agentId)).toBeNull();
    expect(verifyAuditChain(db, companyId).valid).toBe(true);
  });
  it("rejects permission injection and supplied scores and redacts credentials before persistence", () => {
    expect(() => store.create(companyId, proposal({ policy: { may_approve: true } }), owner)).toThrow();
    expect(() =>
      store.create(companyId, proposal({ cases: [{ label: "fake", kind: "run_succeeded", passed: true }] }), owner),
    ).toThrow();
    expect(() => store.create(companyId, proposal({ cases: [] }), owner)).toThrow();
    const key = "sk-or-v1-12345678901234567890123456789012";
    const draft = store.create(companyId, proposal({ guidance: `Quellen prüfen; ${key}` }), owner);
    expect(draft.guidance).not.toContain(key);
    const note = store.note(companyId, { agentId, kind: "lesson", title: "redaction", body: key }, owner);
    expect(note.body).toContain("REDACTED");
  });
  it("rolls back version and review together if audit persistence fails", () => {
    const draft = store.create(companyId, proposal(), owner);
    store.evaluate(companyId, draft.id, owner);
    db.exec(
      "CREATE TRIGGER reject_coaching_audit BEFORE INSERT ON crew_audit_events WHEN NEW.action = 'coaching.applied' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END;",
    );
    expect(() => store.review(companyId, draft.id, { decision: "approve", reason: "review" }, owner)).toThrow(
      "audit unavailable",
    );
    expect(store.current(companyId, agentId)).toBeNull();
    expect(store.snapshot(companyId, agentId).proposals[0].status).toBe("ready");
  });
});
