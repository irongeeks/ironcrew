/**
 * Native coaching workflow inspired conceptually by company OS retrospectives.
 * Cases are deterministic assertions against guidance/installed skill references
 * and persisted run evidence. Their pass count is NOT an estimate of LLM accuracy.
 * No proposal is applied until an owner reviews its exact immutable contents.
 */
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type {
  CoachingCase,
  CoachingCaseResult,
  CoachingEvaluation,
  CoachingNote,
  CoachingProposal,
  CoachingSnapshot,
  CoachingVersion,
} from "../../../src/shared/coaching.ts";
import { appendAuditEvent, type ActorType } from "./audit.ts";
import { redact } from "../security/redaction.ts";

const text = (limit: number) => z.string().trim().min(1).max(limit);
const caseSchema = z
  .object({
    label: text(160),
    kind: z.enum(["guidance_contains", "guidance_excludes", "skill_present", "run_succeeded", "run_output_contains"]),
    expected: text(1000).optional(),
    runId: text(100).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.kind !== "run_succeeded" && !value.expected)
      context.addIssue({ code: "custom", message: "Ein erwarteter Wert ist erforderlich." });
    if (value.kind.startsWith("run_") && !value.runId)
      context.addIssue({ code: "custom", message: "Eine gespeicherte Run-ID ist erforderlich." });
    if (!value.kind.startsWith("run_") && value.runId)
      context.addIssue({ code: "custom", message: "Diese Prüfung verwendet keinen Run." });
  });
const proposalSchema = z
  .object({
    agentId: text(100),
    title: text(200),
    guidance: text(12000),
    skills: z
      .array(text(100))
      .max(40)
      .refine((v) => new Set(v).size === v.length, "Doppelte Skills."),
    cases: z.array(caseSchema).min(1).max(30),
  })
  .strict();
const reviewSchema = z.object({ decision: z.enum(["approve", "reject"]), reason: text(4000) }).strict();
const noteSchema = z
  .object({
    agentId: text(100),
    kind: z.enum(["one_on_one", "retrospective", "lesson"]),
    title: text(200),
    body: text(12000),
    runId: text(100).optional(),
  })
  .strict();
export class CoachingError extends Error {
  constructor(
    message: string,
    public readonly status = 409,
  ) {
    super(message);
    this.name = "CoachingError";
  }
}
export interface CoachingActor {
  actorType: ActorType;
  actorId: string;
}
interface ProposalRow {
  id: string;
  company_id: string;
  agent_id: string;
  title: string;
  guidance: string;
  skills_json: string;
  cases_json: string;
  skill_basis_json: string;
  base_version: number;
  status: CoachingProposal["status"];
  created_by: string;
  created_at: number;
  reviewed_by: string | null;
  review_reason: string;
  correlation_id: string;
}
interface EvaluationRow {
  id: string;
  checks_json: string;
  passed: number;
  created_at: number;
}
interface VersionRow {
  version: number;
  guidance: string;
  skills_json: string;
  proposal_id: string;
  approved_by: string;
  created_at: number;
}
interface EvidenceRun {
  id: string;
  task_id: string;
  status: string;
  input_tokens: number;
  output_tokens: number;
  cost_micros: number;
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const versionView = (row: VersionRow): CoachingVersion => ({
  version: row.version,
  guidance: row.guidance,
  skills: JSON.parse(row.skills_json),
  proposalId: row.proposal_id,
  approvedBy: row.approved_by,
  createdAt: row.created_at,
});
export class CoachingStore {
  constructor(private readonly db: DatabaseSync) {}

  private atomic<T>(fn: () => T): T {
    this.db.exec("SAVEPOINT coaching_mutation");
    try {
      const result = fn();
      this.db.exec("RELEASE coaching_mutation");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK TO coaching_mutation; RELEASE coaching_mutation");
      throw error;
    }
  }
  private agent(companyId: string, agentId: string): void {
    if (!this.db.prepare("SELECT id FROM crew_agents WHERE id = ? AND company_id = ?").get(agentId, companyId))
      throw new CoachingError("Agent nicht gefunden.", 404);
  }
  private actor(companyId: string, actor: CoachingActor, ownerOnly = false): void {
    if (actor.actorType === "agent" && !ownerOnly) {
      this.agent(companyId, actor.actorId);
      return;
    }
    if (actor.actorType !== "owner") throw new CoachingError("Eine menschliche Freigabe ist erforderlich.", 403);
    const user = this.db
      .prepare("SELECT role FROM crew_users WHERE id = ? AND status = 'active'")
      .get(actor.actorId) as { role: string } | undefined;
    const count = this.db.prepare("SELECT COUNT(*) AS n FROM crew_users").get() as { n: number };
    if (!user && count.n === 0 && actor.actorId === "ceo") return;
    if (!user || (ownerOnly ? user.role !== "owner" : !["owner", "operator"].includes(user.role)))
      throw new CoachingError("Keine Berechtigung für diese Coaching-Aktion.", 403);
  }
  private audit(
    companyId: string,
    actor: CoachingActor,
    action: string,
    id: string,
    correlationId: string,
    details: Record<string, unknown>,
  ) {
    appendAuditEvent(this.db, {
      companyId,
      ...actor,
      action,
      entityType: "coaching",
      entityId: id,
      correlationId,
      details,
    });
  }
  private row(companyId: string, id: string): ProposalRow {
    const row = this.db
      .prepare("SELECT * FROM crew_coaching_proposals WHERE company_id = ? AND id = ?")
      .get(companyId, id) as ProposalRow | undefined;
    if (!row) throw new CoachingError("Coaching-Vorschlag nicht gefunden.", 404);
    this.agent(companyId, row.agent_id);
    return row;
  }
  private evaluation(companyId: string, id: string): CoachingEvaluation | null {
    const row = this.db
      .prepare(
        "SELECT * FROM crew_coaching_evaluations WHERE company_id = ? AND proposal_id = ? ORDER BY rowid DESC LIMIT 1",
      )
      .get(companyId, id) as EvaluationRow | undefined;
    if (!row) return null;
    const checks = JSON.parse(row.checks_json) as CoachingCaseResult[];
    return {
      id: row.id,
      createdAt: row.created_at,
      passed: row.passed === 1,
      passedCases: checks.filter((v) => v.passed).length,
      totalCases: checks.length,
      checks,
    };
  }
  private view(row: ProposalRow): CoachingProposal {
    return {
      id: row.id,
      agentId: row.agent_id,
      title: row.title,
      guidance: row.guidance,
      skills: JSON.parse(row.skills_json),
      cases: JSON.parse(row.cases_json),
      baseVersion: row.base_version,
      status: row.status,
      createdAt: row.created_at,
      createdBy: row.created_by,
      reviewReason: row.review_reason,
      reviewedBy: row.reviewed_by,
      evaluation: this.evaluation(row.company_id, row.id),
    };
  }
  current(companyId: string, agentId: string): CoachingVersion | null {
    this.agent(companyId, agentId);
    const row = this.db
      .prepare(
        "SELECT * FROM crew_agent_guidance_versions WHERE company_id = ? AND agent_id = ? ORDER BY version DESC LIMIT 1",
      )
      .get(companyId, agentId) as VersionRow | undefined;
    return row ? versionView(row) : null;
  }
  private skillBasis(companyId: string, skills: string[]): string {
    return JSON.stringify(
      skills.map((name) => {
        const row = this.db
          .prepare(
            "SELECT id,name,version,source_url,manifest FROM crew_marketplace_installs WHERE company_id = ? AND entry_type = 'skill' AND name = ?",
          )
          .get(companyId, name);
        if (!row) throw new CoachingError(`Skill „${name}“ ist in dieser Firma nicht installiert.`, 400);
        return hash(JSON.stringify(row));
      }),
    );
  }
  snapshot(companyId: string, agentId: string): CoachingSnapshot {
    this.agent(companyId, agentId);
    const proposals = (
      this.db
        .prepare(
          "SELECT * FROM crew_coaching_proposals WHERE company_id = ? AND agent_id = ? ORDER BY rowid DESC LIMIT 100",
        )
        .all(companyId, agentId) as unknown as ProposalRow[]
    ).map((row) => this.view(row));
    const notes = this.db
      .prepare(
        `SELECT id,agent_id AS agentId,kind,title,body,run_id AS runId,created_by AS createdBy,created_at AS createdAt FROM crew_coaching_notes WHERE company_id = ? AND agent_id = ? ORDER BY rowid DESC LIMIT 100`,
      )
      .all(companyId, agentId) as unknown as CoachingNote[];
    const versions = (
      this.db
        .prepare(
          "SELECT * FROM crew_agent_guidance_versions WHERE company_id = ? AND agent_id = ? ORDER BY version DESC LIMIT 100",
        )
        .all(companyId, agentId) as unknown as VersionRow[]
    ).map(versionView);
    const skills = (
      this.db
        .prepare(
          "SELECT name FROM crew_marketplace_installs WHERE company_id = ? AND entry_type = 'skill' ORDER BY name LIMIT 500",
        )
        .all(companyId) as { name: string }[]
    ).map((row) => row.name);
    return { proposals, notes, versions, current: versions[0] ?? null, skills };
  }
  create(companyId: string, raw: unknown, actor: CoachingActor): CoachingProposal {
    const input = proposalSchema.parse(raw);
    this.actor(companyId, actor);
    this.agent(companyId, input.agentId);
    // Persist redacted content; never let API-provided "passed" or permission fields through.
    const guidance = redact(input.guidance).text;
    const cases = input.cases.map((c) => ({
      ...c,
      label: redact(c.label).text,
      ...(c.expected ? { expected: redact(c.expected).text } : {}),
    }));
    return this.atomic(() => {
      for (const check of cases) if (check.runId) this.run(companyId, input.agentId, check.runId);
      const skillBasis = this.skillBasis(companyId, input.skills);
      const id = `coach_${randomUUID()}`;
      const correlationId = `corr_${randomUUID()}`;
      this.db
        .prepare(
          `INSERT INTO crew_coaching_proposals (id,company_id,agent_id,title,guidance,skills_json,cases_json,skill_basis_json,base_version,status,created_by,created_at,correlation_id) VALUES (?,?,?,?,?,?,?,?,?,'draft',?,?,?)`,
        )
        .run(
          id,
          companyId,
          input.agentId,
          redact(input.title).text,
          guidance,
          JSON.stringify(input.skills),
          JSON.stringify(cases),
          skillBasis,
          this.current(companyId, input.agentId)?.version ?? 0,
          actor.actorId,
          Date.now(),
          correlationId,
        );
      this.audit(companyId, actor, "coaching.proposed", id, correlationId, {
        agentId: input.agentId,
        caseCount: cases.length,
        guidanceHash: hash(guidance),
      });
      return this.view(this.row(companyId, id));
    });
  }
  private run(companyId: string, agentId: string, runId: string): EvidenceRun {
    const run = this.db
      .prepare(
        "SELECT id,task_id,status,input_tokens,output_tokens,cost_micros FROM crew_runs WHERE company_id = ? AND agent_id = ? AND id = ?",
      )
      .get(companyId, agentId, runId) as EvidenceRun | undefined;
    if (!run) throw new CoachingError("Run-Nachweis gehört nicht zu diesem Agenten und dieser Firma.", 404);
    if (!["completed", "failed", "cancelled"].includes(run.status))
      throw new CoachingError("Run-Nachweise müssen abgeschlossen sein.");
    return run;
  }
  private checks(row: ProposalRow): CoachingCaseResult[] {
    const skills = JSON.parse(row.skills_json) as string[];
    if (this.skillBasis(row.company_id, skills) !== row.skill_basis_json)
      throw new CoachingError("Installierte Skills wurden geändert. Bitte einen neuen Vorschlag erstellen.");
    return (JSON.parse(row.cases_json) as CoachingCase[]).map((check) => {
      let passed = false;
      let observed = "";
      let evidenceHash: string | null = null;
      if (check.kind === "guidance_contains" || check.kind === "guidance_excludes") {
        const present = row.guidance.includes(check.expected!);
        passed = check.kind === "guidance_contains" ? present : !present;
        observed = present ? "Text vorhanden" : "Text nicht vorhanden";
      } else if (check.kind === "skill_present") {
        passed = skills.includes(check.expected!);
        observed = passed ? "Installierte Skill-Referenz gewählt" : "Skill-Referenz fehlt";
      } else {
        const run = this.run(row.company_id, row.agent_id, check.runId!);
        // Bound both row count and total bytes before loading event content into JS.
        const size = this.db
          .prepare(
            "SELECT COUNT(*) AS n,COALESCE(SUM(length(payload_json)),0) AS bytes FROM crew_run_events WHERE company_id = ? AND run_id = ? AND type IN ('message.completed','run.completed')",
          )
          .get(row.company_id, run.id) as { n: number; bytes: number };
        if (size.n > 2000 || size.bytes > 2_000_000)
          throw new CoachingError("Run-Nachweis überschreitet das Auswertungslimit.", 413);
        const events = this.db
          .prepare(
            "SELECT type,payload_json FROM crew_run_events WHERE company_id = ? AND run_id = ? AND type IN ('message.completed','run.completed') ORDER BY seq",
          )
          .all(row.company_id, run.id) as { type: string; payload_json: string }[];
        const output = events
          .map((e) => {
            const payload = JSON.parse(e.payload_json) as { text?: unknown; summary?: unknown };
            const value = e.type === "message.completed" ? payload.text : payload.summary;
            return typeof value === "string" ? value : "";
          })
          .join("\n");
        evidenceHash = hash(JSON.stringify({ run, events }));
        passed = run.status === "completed" && (check.kind === "run_succeeded" || output.includes(check.expected!));
        observed = `Run ${run.status}; ${run.input_tokens} Eingabe-/ ${run.output_tokens} Ausgabetoken; ${run.cost_micros} Kosten-Mikroeinheiten; ${check.kind === "run_output_contains" ? (output.includes(check.expected!) ? "Text gefunden" : "Text nicht gefunden") : "Statusprüfung"}`;
      }
      return { ...check, passed, observed, evidenceHash };
    });
  }
  evaluate(companyId: string, id: string, actor: CoachingActor): CoachingProposal {
    this.actor(companyId, actor);
    return this.atomic(() => {
      const row = this.row(companyId, id);
      if (["applied", "rejected"].includes(row.status)) throw new CoachingError("Dieser Vorschlag ist abgeschlossen.");
      const checks = this.checks(row);
      const passed = checks.every((c) => c.passed);
      const evaluationId = `eval_${randomUUID()}`;
      this.db
        .prepare(
          "INSERT INTO crew_coaching_evaluations (id,company_id,proposal_id,checks_json,passed,created_at,created_by) VALUES (?,?,?,?,?,?,?)",
        )
        .run(evaluationId, companyId, id, JSON.stringify(checks), passed ? 1 : 0, Date.now(), actor.actorId);
      this.db
        .prepare("UPDATE crew_coaching_proposals SET status = ? WHERE company_id = ? AND id = ?")
        .run(passed ? "ready" : "failed", companyId, id);
      this.audit(companyId, actor, "coaching.evaluated", id, row.correlation_id, {
        evaluationId,
        passed,
        passedCases: checks.filter((c) => c.passed).length,
        totalCases: checks.length,
      });
      return this.view(this.row(companyId, id));
    });
  }
  review(companyId: string, id: string, raw: unknown, actor: CoachingActor): CoachingProposal {
    const input = reviewSchema.parse(raw);
    this.actor(companyId, actor, true);
    return this.atomic(() => {
      const row = this.row(companyId, id);
      if (["applied", "rejected"].includes(row.status))
        throw new CoachingError("Dieser Vorschlag wurde bereits entschieden.");
      if (input.decision === "approve") {
        const evaluation = this.evaluation(companyId, id);
        if (row.status !== "ready" || !evaluation?.passed)
          throw new CoachingError("Erst alle Qualitätsprüfungen bestehen, dann freigeben.");
        if ((this.current(companyId, row.agent_id)?.version ?? 0) !== row.base_version)
          throw new CoachingError("Die Guidance-Version wurde inzwischen geändert. Bitte neuen Vorschlag erstellen.");
        if (JSON.stringify(this.checks(row)) !== JSON.stringify(evaluation.checks))
          throw new CoachingError("Run-Nachweise wurden seit der Auswertung verändert. Bitte erneut prüfen.");
        this.db
          .prepare(
            "INSERT INTO crew_agent_guidance_versions (company_id,agent_id,version,guidance,skills_json,proposal_id,approved_by,created_at) VALUES (?,?,?,?,?,?,?,?)",
          )
          .run(
            companyId,
            row.agent_id,
            row.base_version + 1,
            row.guidance,
            row.skills_json,
            id,
            actor.actorId,
            Date.now(),
          );
      }
      this.db
        .prepare(
          "UPDATE crew_coaching_proposals SET status = ?,reviewed_by = ?,review_reason = ? WHERE company_id = ? AND id = ?",
        )
        .run(
          input.decision === "approve" ? "applied" : "rejected",
          actor.actorId,
          redact(input.reason).text,
          companyId,
          id,
        );
      this.audit(
        companyId,
        actor,
        input.decision === "approve" ? "coaching.applied" : "coaching.rejected",
        id,
        row.correlation_id,
        {
          agentId: row.agent_id,
          version: input.decision === "approve" ? row.base_version + 1 : null,
          reason: redact(input.reason).text,
          evaluationId: this.evaluation(companyId, id)?.id ?? null,
        },
      );
      return this.view(this.row(companyId, id));
    });
  }
  note(companyId: string, raw: unknown, actor: CoachingActor): CoachingNote {
    const input = noteSchema.parse(raw);
    this.actor(companyId, actor);
    this.agent(companyId, input.agentId);
    return this.atomic(() => {
      if (input.runId) this.run(companyId, input.agentId, input.runId);
      const note: CoachingNote = {
        id: `coachnote_${randomUUID()}`,
        agentId: input.agentId,
        kind: input.kind,
        title: redact(input.title).text,
        body: redact(input.body).text,
        runId: input.runId ?? null,
        createdBy: actor.actorId,
        createdAt: Date.now(),
      };
      const correlationId = `corr_${randomUUID()}`;
      this.db
        .prepare(
          "INSERT INTO crew_coaching_notes (id,company_id,agent_id,kind,title,body,run_id,created_by,created_at,correlation_id) VALUES (?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          note.id,
          companyId,
          note.agentId,
          note.kind,
          note.title,
          note.body,
          note.runId,
          note.createdBy,
          note.createdAt,
          correlationId,
        );
      this.audit(companyId, actor, "coaching.note_recorded", note.id, correlationId, {
        agentId: note.agentId,
        kind: note.kind,
        runId: note.runId,
        bodyHash: hash(note.body),
      });
      return note;
    });
  }
}
