import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../domain/test-db.ts";
import { CompanyOrchestrator } from "./company.ts";
import { StubRuntime, stubEvent } from "../runtime/__fixtures__/stub-runtime.ts";
import type { RunContext, RunInput } from "../runtime/run-events.ts";
class CaptureRuntime extends StubRuntime {
  calls: Array<{ input: RunInput; context: RunContext }> = [];
  constructor() {
    super("mock");
  }
  override async *startRun(input: RunInput, context: RunContext) {
    this.calls.push({ input, context });
    yield stubEvent(context, "message.completed", { text: "Review complete" });
    yield stubEvent(context, "run.completed", {}, 1);
  }
}
let db: DatabaseSync;
let orc: CompanyOrchestrator;
let runtime: CaptureRuntime;
let companyId: string;
beforeEach(() => {
  db = createTestDb();
  orc = new CompanyOrchestrator(db);
  companyId = orc.seedCompany({ name: "Meetings", slug: "meeting-coaching" });
  runtime = new CaptureRuntime();
  orc.registerRuntime(runtime);
});
afterEach(() => db.close());
describe("owner-approved coaching in meeting turns", () => {
  it("applies only the current approved guidance for the actual speaker and audits its version", async () => {
    const agent = orc.getAgent(companyId, "cto")!;
    const other = orc.getAgent(companyId, "coo")!;
    const actor = { actorType: "owner" as const, actorId: "ceo" };
    const instruction = "Jedes Meeting mit prüfbaren Quellenbelegen abschließen.";
    const proposal = orc.coaching.create(
      companyId,
      {
        agentId: agent.id,
        title: "Quellen",
        guidance: instruction,
        skills: [],
        cases: [{ label: "Quellenregel", kind: "guidance_contains", expected: "Quellenbelegen" }],
      },
      actor,
    );
    orc.coaching.evaluate(companyId, proposal.id, actor);
    const meeting = orc.meetings.create({
      companyId,
      topic: "Architecture",
      moderatorAgentId: agent.id,
      participantAgentIds: [other.id],
      maxRounds: 4,
    });
    orc.meetings.start(meeting.id);
    await orc.runMeetingTurn(companyId, meeting.id, { agentId: agent.id });
    expect(runtime.calls[0].input.prompt).not.toContain(instruction);
    orc.coaching.review(companyId, proposal.id, { decision: "approve", reason: "Fachlich geprüft" }, actor);
    await orc.runMeetingTurn(companyId, meeting.id, { agentId: agent.id });
    expect(runtime.calls[1].input.prompt).toContain(instruction);
    expect(runtime.calls[1].input.prompt).toContain("untergeordnet zu Policy");
    expect(runtime.calls[1].context.permissionMode).toBe("restricted");
    await orc.runMeetingTurn(companyId, meeting.id, { agentId: other.id });
    expect(runtime.calls[2].input.prompt).not.toContain(instruction);
    expect(
      db
        .prepare(
          "SELECT details_json FROM crew_audit_events WHERE action='coaching.meeting_context_used' AND entity_id=?",
        )
        .all(meeting.id),
    ).toEqual([{ details_json: expect.stringContaining('"version":1') }]);
    expect(orc.getAgent(companyId, "cto")!.policy_json).toBe(agent.policy_json);
  });
});
