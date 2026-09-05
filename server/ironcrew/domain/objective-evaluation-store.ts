/** Original IronCrew implementation: deterministic assertions over persisted run output.
 * A passing assertion proves only its stated predicate, never general model quality.
 */
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type {
  ObjectiveCase,
  ObjectiveEvidenceRun,
  ObjectiveMeasurement,
  ObjectiveRubric,
  ObjectiveSnapshot,
} from "../../../src/shared/objective-evaluations.ts";
import { appendAuditEvent, canonicalJson } from "./audit.ts";
import { redact } from "../security/redaction.ts";
const text = (max: number) => z.string().trim().min(1).max(max);
const textCase = (kind: "contains" | "excludes") =>
  z.object({ id: text(80), label: text(160), kind: z.literal(kind), expected: text(2000) }).strict();
const caseSchema = z.discriminatedUnion("kind", [
  textCase("contains"),
  textCase("excludes"),
  z
    .object({
      id: text(80),
      label: text(160),
      kind: z.literal("json_field"),
      path: z
        .array(text(100).refine((v) => !["__proto__", "constructor", "prototype"].includes(v)))
        .min(1)
        .max(12),
      valueType: z.enum(["string", "number", "boolean", "array", "object", "null"]),
    })
    .strict(),
]);
const rubricSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    baseVersion: z.number().int().nonnegative(),
    title: text(160),
    reason: z.string().trim().min(10).max(1000),
    cases: z
      .array(caseSchema)
      .min(1)
      .max(30)
      .refine((v) => new Set(v.map((c) => c.id)).size === v.length, "Prüf-IDs müssen eindeutig sein."),
  })
  .strict();
const measureSchema = z.object({ rubricId: text(100), runId: text(100) }).strict();
type Actor = { actorType: "owner"; actorId: string };
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const runColumns = `r.id,r.task_id AS taskId,t.title AS taskTitle,r.agent_id AS agentId,a.display_name AS agentName,r.runtime_type AS runtimeType,r.model,r.status,r.input_tokens AS inputTokens,r.output_tokens AS outputTokens,r.cost_micros AS costMicros`;
const runJoin = `FROM crew_runs r JOIN crew_tasks t ON t.id=r.task_id AND t.company_id=r.company_id JOIN crew_agents a ON a.id=r.agent_id AND a.company_id=r.company_id`;
export class ObjectiveEvaluationError extends Error {
  constructor(
    message: string,
    public readonly status = 409,
  ) {
    super(message);
    this.name = "ObjectiveEvaluationError";
  }
}
function checkOutput(cases: ObjectiveCase[], output: string): ObjectiveMeasurement["checks"] {
  let json: unknown;
  try {
    json = JSON.parse(output);
  } catch {
    json = undefined;
  }
  return cases.map((c) => {
    let passed: boolean;
    let observed: string;
    if (c.kind === "json_field") {
      let value = json;
      for (const key of c.path) {
        value =
          value !== null && typeof value === "object" && Object.hasOwn(value, key)
            ? (value as Record<string, unknown>)[key]
            : undefined;
      }
      const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
      passed = actual === c.valueType;
      observed =
        json === undefined
          ? "Ergebnis ist kein gültiges JSON."
          : `Feldtyp: ${actual === "undefined" ? "fehlt" : actual}`;
    } else {
      const present = output.includes(c.expected);
      passed = c.kind === "contains" ? present : !present;
      observed = present ? "Text vorhanden" : "Text nicht vorhanden";
    }
    return { caseId: c.id, label: c.label, passed, observed };
  });
}
export class ObjectiveEvaluationStore {
  constructor(private readonly db: DatabaseSync) {}
  private atomic<T>(fn: () => T): T {
    this.db.exec("SAVEPOINT objective_evaluation");
    try {
      const result = fn();
      this.db.exec("RELEASE objective_evaluation");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK TO objective_evaluation; RELEASE objective_evaluation");
      throw error;
    }
  }
  permissions(actor: Actor): { canEdit: boolean; canMeasure: boolean } {
    const user = this.db.prepare("SELECT role FROM crew_users WHERE id=? AND status='active'").get(actor.actorId) as
      | { role: string }
      | undefined;
    const count = this.db.prepare("SELECT COUNT(*) AS n FROM crew_users").get() as { n: number };
    const role = user?.role ?? (count.n === 0 && actor.actorId === "ceo" ? "owner" : "none");
    return {
      canEdit: actor.actorType === "owner" && role === "owner",
      canMeasure: actor.actorType === "owner" && ["operator", "owner"].includes(role),
    };
  }
  private authorize(actor: Actor, edit = false): void {
    const rights = this.permissions(actor);
    if (edit ? !rights.canEdit : !rights.canMeasure)
      throw new ObjectiveEvaluationError("Keine Berechtigung für diese Auswertung.", 403);
  }
  private rubric(companyId: string, id: string): ObjectiveRubric {
    const row = this.db
      .prepare("SELECT rubric_json FROM crew_objective_rubrics WHERE company_id=? AND id=?")
      .get(companyId, id) as { rubric_json: string } | undefined;
    if (!row) throw new ObjectiveEvaluationError("Rubrik nicht gefunden.", 404);
    return JSON.parse(row.rubric_json) as ObjectiveRubric;
  }
  snapshot(companyId: string, actor: Actor): ObjectiveSnapshot {
    const rubrics = (
      this.db
        .prepare("SELECT rubric_json FROM crew_objective_rubrics WHERE company_id=? ORDER BY rowid DESC LIMIT 200")
        .all(companyId) as { rubric_json: string }[]
    ).map((r) => JSON.parse(r.rubric_json) as ObjectiveRubric);
    const measurements = (
      this.db
        .prepare(
          "SELECT measurement_json FROM crew_objective_measurements WHERE company_id=? ORDER BY rowid DESC LIMIT 200",
        )
        .all(companyId) as { measurement_json: string }[]
    ).map((r) => JSON.parse(r.measurement_json) as ObjectiveMeasurement);
    const runs = this.db
      .prepare(
        `SELECT ${runColumns} ${runJoin} WHERE r.company_id=? AND r.status='completed' ORDER BY r.created_at DESC,r.id LIMIT 200`,
      )
      .all(companyId) as unknown as ObjectiveEvidenceRun[];
    const comparisons = this.db
      .prepare(
        `SELECT m.rubric_id AS rubricId,m.agent_id AS agentId,a.display_name AS agentName,m.runtime_type AS runtimeType,m.model,COUNT(*) AS runCount,ROUND(AVG(m.score),2) AS score FROM crew_objective_measurements m JOIN crew_agents a ON a.id=m.agent_id AND a.company_id=m.company_id WHERE m.company_id=? GROUP BY m.rubric_id,m.agent_id,m.runtime_type,m.model ORDER BY m.rubric_id,m.agent_id LIMIT 500`,
      )
      .all(companyId) as unknown as ObjectiveSnapshot["comparisons"];
    return { rubrics, measurements, runs, comparisons, ...this.permissions(actor) };
  }
  createRubric(companyId: string, raw: unknown, actor: Actor): ObjectiveRubric {
    this.authorize(actor, true);
    const input = rubricSchema.parse(raw);
    // A redacted assertion would silently change the test. Reject it rather than persisting a secret or weakened rule.
    if (redact(JSON.stringify(input)).text !== JSON.stringify(input))
      throw new ObjectiveEvaluationError("Prüfkriterien dürfen keine Secrets enthalten.", 400);
    return this.atomic(() => {
      const current = this.db
        .prepare(
          "SELECT COALESCE(MAX(version),0) AS version FROM crew_objective_rubrics WHERE company_id=? AND rubric_key=?",
        )
        .get(companyId, input.key) as { version: number };
      if (current.version !== input.baseVersion)
        throw new ObjectiveEvaluationError(
          "Rubrik wurde inzwischen geändert. Aktuellen Stand laden und erneut prüfen.",
        );
      const rubric: ObjectiveRubric = {
        id: `rubric_${randomUUID()}`,
        key: input.key,
        version: current.version + 1,
        title: input.title,
        reason: input.reason,
        cases: input.cases,
        hash: hash({ engineVersion: 1, cases: input.cases }),
        createdAt: Date.now(),
        createdBy: actor.actorId,
      };
      this.db
        .prepare("INSERT INTO crew_objective_rubrics(id,company_id,rubric_key,version,rubric_json) VALUES(?,?,?,?,?)")
        .run(rubric.id, companyId, rubric.key, rubric.version, JSON.stringify(rubric));
      appendAuditEvent(this.db, {
        companyId,
        ...actor,
        action: "evaluation.rubric_created",
        entityType: "evaluation",
        entityId: rubric.id,
        correlationId: `corr_${randomUUID()}`,
        details: { key: rubric.key, version: rubric.version, rubricHash: rubric.hash, reason: rubric.reason },
      });
      return rubric;
    });
  }
  measure(companyId: string, raw: unknown, actor: Actor): ObjectiveMeasurement {
    this.authorize(actor);
    const input = measureSchema.parse(raw);
    return this.atomic(() => {
      const rubric = this.rubric(companyId, input.rubricId);
      const run = this.db
        .prepare(`SELECT ${runColumns} ${runJoin} WHERE r.company_id=? AND r.id=?`)
        .get(companyId, input.runId) as ObjectiveEvidenceRun | undefined;
      if (!run) throw new ObjectiveEvaluationError("Run, Aufgabe und Mitarbeiter müssen zu dieser Firma gehören.", 404);
      if (run.status !== "completed")
        throw new ObjectiveEvaluationError("Nur abgeschlossene Runs können ausgewertet werden.");
      const size = this.db
        .prepare(
          "SELECT COUNT(*) AS n,COALESCE(SUM(length(CAST(payload_json AS BLOB))),0) AS bytes FROM crew_run_events WHERE company_id=? AND run_id=? AND type='message.completed'",
        )
        .get(companyId, run.id) as { n: number; bytes: number };
      if (size.n > 2000 || size.bytes > 2_000_000)
        throw new ObjectiveEvaluationError("Ergebnis überschreitet das Auswertungslimit.", 413);
      const events = this.db
        .prepare(
          "SELECT id,seq,task_id,agent_id,payload_json FROM crew_run_events WHERE company_id=? AND run_id=? AND type='message.completed' ORDER BY seq",
        )
        .all(companyId, run.id) as {
        id: string;
        seq: number;
        task_id: string;
        agent_id: string | null;
        payload_json: string;
      }[];
      if (!events.length)
        throw new ObjectiveEvaluationError("Dieser Run hat kein gespeichertes finales Nachrichtenergebnis.");
      if (events.some((e) => e.task_id !== run.taskId || e.agent_id !== run.agentId))
        throw new ObjectiveEvaluationError("Widersprüchliche Zuordnung im Run-Nachweis.");
      const outputs = events.map((e) => {
        const payload: unknown = JSON.parse(e.payload_json);
        if (!payload || typeof payload !== "object" || !("text" in payload) || typeof payload.text !== "string")
          throw new ObjectiveEvaluationError("Run enthält kein gültiges finales Textergebnis.");
        return redact(payload.text).text;
      });
      const output = outputs.join("\n");
      if (!output.trim()) throw new ObjectiveEvaluationError("Leere Ergebnisse können nicht ausgewertet werden.");
      // Display names may change after a run. Hash only its persisted execution
      // identity and usage; keep the original labels in the measurement view.
      const evidence = {
        run: {
          id: run.id,
          taskId: run.taskId,
          agentId: run.agentId,
          runtimeType: run.runtimeType,
          model: run.model,
          status: run.status,
          inputTokens: run.inputTokens,
          outputTokens: run.outputTokens,
          costMicros: run.costMicros,
        },
        events: events.map((e, i) => ({ id: e.id, seq: e.seq, text: outputs[i] })),
      };
      const evidenceHash = hash(evidence);
      const existing = this.db
        .prepare(
          "SELECT measurement_json FROM crew_objective_measurements WHERE company_id=? AND rubric_id=? AND run_id=?",
        )
        .get(companyId, rubric.id, run.id) as { measurement_json: string } | undefined;
      if (existing) {
        const measurement = JSON.parse(existing.measurement_json) as ObjectiveMeasurement;
        if (measurement.evidenceHash !== evidenceHash)
          throw new ObjectiveEvaluationError(
            "Run-Nachweis hat sich seit der Messung verändert. Gespeicherte Auswertung bleibt erhalten.",
          );
        return measurement;
      }
      const checks = checkOutput(rubric.cases, output);
      const passedCases = checks.filter((c) => c.passed).length;
      const measurement: ObjectiveMeasurement = {
        id: `eval_${randomUUID()}`,
        rubricId: rubric.id,
        rubricHash: rubric.hash,
        engineVersion: 1,
        run,
        evidenceHash,
        outputHash: hash(output),
        checks,
        passedCases,
        totalCases: checks.length,
        score: Math.round((passedCases / checks.length) * 10000) / 100,
        createdAt: Date.now(),
        createdBy: actor.actorId,
      };
      this.db
        .prepare(
          "INSERT INTO crew_objective_measurements(id,company_id,rubric_id,run_id,agent_id,runtime_type,model,score,measurement_json,evidence_json) VALUES(?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          measurement.id,
          companyId,
          rubric.id,
          run.id,
          run.agentId,
          run.runtimeType,
          run.model,
          measurement.score,
          JSON.stringify(measurement),
          JSON.stringify(evidence),
        );
      appendAuditEvent(this.db, {
        companyId,
        ...actor,
        action: "evaluation.measured",
        entityType: "evaluation",
        entityId: measurement.id,
        taskId: run.taskId,
        runId: run.id,
        correlationId: `corr_${randomUUID()}`,
        details: {
          rubricId: rubric.id,
          rubricHash: rubric.hash,
          evidenceHash,
          passedCases,
          totalCases: checks.length,
          score: measurement.score,
        },
      });
      return measurement;
    });
  }
  replay(companyId: string, id: string): ObjectiveMeasurement["checks"] {
    const row = this.db
      .prepare(
        "SELECT rubric_id,measurement_json,evidence_json FROM crew_objective_measurements WHERE company_id=? AND id=?",
      )
      .get(companyId, id) as { rubric_id: string; measurement_json: string; evidence_json: string } | undefined;
    if (!row) throw new ObjectiveEvaluationError("Auswertung nicht gefunden.", 404);
    const evidence = JSON.parse(row.evidence_json) as { events: { text: string }[] };
    const measurement = JSON.parse(row.measurement_json) as ObjectiveMeasurement;
    const rubric = this.rubric(companyId, row.rubric_id);
    if (
      measurement.engineVersion !== 1 ||
      hash(evidence) !== measurement.evidenceHash ||
      rubric.hash !== measurement.rubricHash ||
      hash({ engineVersion: 1, cases: rubric.cases }) !== rubric.hash ||
      hash(evidence.events.map((e) => e.text).join("\n")) !== measurement.outputHash
    )
      throw new ObjectiveEvaluationError("Integritätsprüfung der gespeicherten Auswertung fehlgeschlagen.");
    return checkOutput(rubric.cases, evidence.events.map((e) => e.text).join("\n"));
  }
}
