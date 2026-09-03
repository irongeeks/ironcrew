import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import type { DatabaseSync } from "node:sqlite";
import { createTestDb } from "../domain/test-db.ts";
import { registerIronCommandRoutes } from "./routes.ts";
import { CompanyOrchestrator } from "../orchestrator/company.ts";
import { MockRuntime } from "../runtime/mock-runtime.ts";

let db: DatabaseSync;
let app: Express;
let companyId: string;
let broadcasts: Array<{ type: string; payload: unknown }>;
let orchestrator: CompanyOrchestrator;

beforeEach(() => {
  db = createTestDb();
  app = express();
  app.use(express.json());
  broadcasts = [];
  orchestrator = new CompanyOrchestrator(db);
  orchestrator.registerRuntime(new MockRuntime({ responseText: "Bericht erstellt." }));
  const api = registerIronCommandRoutes(app, {
    db,
    orchestrator,
    broadcast: (type, payload) => broadcasts.push({ type, payload }),
  });
  companyId = api.companyId;
  // Express 5 surfaces unhandled errors; keep the test output honest.
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: "internal", message: err.message });
  });
});

afterEach(() => db.close());

describe("company and org", () => {
  it("returns the company and its departments", async () => {
    const res = await request(app).get("/api/ic/company").expect(200);
    expect(res.body.company.id).toBe(companyId);
    expect(res.body.departments.length).toBeGreaterThan(5);
  });

  it("returns agents with persona and policy kept separate", async () => {
    const res = await request(app).get("/api/ic/agents").expect(200);
    const finance = res.body.agents.find((a: { key: string }) => a.key === "finance");
    expect(finance.persona.display_name).toBeTruthy();
    expect(finance.persona.allowed_tools).toBeUndefined();
    expect(finance.policy.may_approve).toBe(false);
    expect(finance.status).toBe("idle");
  });
});

describe("CEO chat", () => {
  it("accepts a message and returns the triage decision", async () => {
    const res = await request(app)
      .post("/api/ic/chat")
      .send({ body: "Bitte dokumentiere das Deployment-Verfahren." })
      .expect(201);
    expect(res.body.triage.category).toBe("simple_task");
    expect(res.body.task.status).toBe("ready");
    expect(res.body.reply).toBeTruthy();
  });

  it("broadcasts the reply and the task change", async () => {
    await request(app).post("/api/ic/chat").send({ body: "Bitte erstelle eine Übersicht." }).expect(201);
    expect(broadcasts.map((b) => b.type)).toEqual(expect.arrayContaining(["ic_chat_message", "ic_task_changed"]));
  });

  it("rejects an empty message", async () => {
    const res = await request(app).post("/api/ic/chat").send({ body: "" }).expect(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("rejects a missing body", async () => {
    await request(app).post("/api/ic/chat").send({}).expect(400);
  });

  it("returns the conversation history", async () => {
    await request(app).post("/api/ic/chat").send({ body: "Bitte analysiere die Logs." });
    const res = await request(app).get("/api/ic/chat").expect(200);
    expect(res.body.messages).toHaveLength(2);
  });

  it("blocks a sensitive request at the API, not just in the UI", async () => {
    const res = await request(app)
      .post("/api/ic/chat")
      .send({ body: "Bitte überweise 5.000 EUR an den Lieferanten." })
      .expect(201);
    expect(res.body.task.status).toBe("approval_required");
    expect(res.body.assignedAgent).toBeNull();

    const approvals = await request(app).get("/api/ic/approvals").expect(200);
    expect(approvals.body.approvals[0].approval_type).toBe("bank_transfer");
  });
});

describe("task lifecycle over HTTP", () => {
  async function seedTask() {
    const res = await request(app)
      .post("/api/ic/chat")
      .send({ body: "Bitte dokumentiere das Backup-Verfahren." })
      .expect(201);
    return res.body.task.id as string;
  }

  it("executes, reviews and accepts a task", async () => {
    const taskId = await seedTask();

    const exec = await request(app).post("/api/ic/tasks/execute-next").expect(200);
    expect(exec.body.executed).toBe(true);
    expect(exec.body.task.status).toBe("review");

    const accepted = await request(app).post(`/api/ic/tasks/${taskId}/accept`).send({ note: "Passt." }).expect(200);
    expect(accepted.body.task.status).toBe("done");
  });

  it("supports requesting a revision", async () => {
    const taskId = await seedTask();
    await request(app).post("/api/ic/tasks/execute-next").expect(200);

    const revised = await request(app)
      .post(`/api/ic/tasks/${taskId}/revise`)
      .send({ reason: "Bitte mit mehr Details." })
      .expect(200);
    expect(revised.body.task.status).toBe("ready");
  });

  it("rejects a revision without a reason", async () => {
    const taskId = await seedTask();
    await request(app).post("/api/ic/tasks/execute-next");
    await request(app).post(`/api/ic/tasks/${taskId}/revise`).send({}).expect(400);
  });

  it("refuses to accept a task that is not in review", async () => {
    const taskId = await seedTask();
    const res = await request(app).post(`/api/ic/tasks/${taskId}/accept`).send({}).expect(409);
    expect(res.body.error).toBe("cannot_accept");
  });

  it("reports when nothing is claimable", async () => {
    const res = await request(app).post("/api/ic/tasks/execute-next").expect(200);
    expect(res.body.executed).toBe(false);
  });

  it("broadcasts run events during execution", async () => {
    await seedTask();
    await request(app).post("/api/ic/tasks/execute-next").expect(200);
    const runEvents = broadcasts.filter((b) => b.type === "ic_run_event");
    expect(runEvents.length).toBeGreaterThan(3);
  });

  it("returns task detail with runs and audit trail", async () => {
    const taskId = await seedTask();
    await request(app).post("/api/ic/tasks/execute-next");
    const res = await request(app).get(`/api/ic/tasks/${taskId}`).expect(200);
    expect(res.body.runs).toHaveLength(1);
    expect(res.body.audit.length).toBeGreaterThan(0);
  });

  it("404s for an unknown task", async () => {
    await request(app).get("/api/ic/tasks/task_missing").expect(404);
  });

  it("validates the status filter", async () => {
    await request(app).get("/api/ic/tasks?status=nonsense").expect(400);
    await request(app).get("/api/ic/tasks?status=ready").expect(200);
  });

  it("replays run events", async () => {
    await seedTask();
    const exec = await request(app).post("/api/ic/tasks/execute-next");
    const res = await request(app).get(`/api/ic/runs/${exec.body.runId}/events`).expect(200);
    expect(res.body.events.length).toBe(exec.body.eventCount);
    expect(res.body.events[0].type).toBe("run.started");
  });

  describe("generic status move (Kanban drag & drop)", () => {
    it("moves a task along a legal transition", async () => {
      const taskId = await seedTask();
      const res = await request(app).post(`/api/ic/tasks/${taskId}/status`).send({ status: "blocked" }).expect(200);
      expect(res.body.task.status).toBe("blocked");
      expect(broadcasts.some((b) => b.type === "ic_task_changed")).toBe(true);
    });

    it("rejects an illegal transition with 409, never applying it", async () => {
      const taskId = await seedTask();
      const res = await request(app).post(`/api/ic/tasks/${taskId}/status`).send({ status: "done" }).expect(409);
      expect(res.body.error).toBe("invalid_transition");

      const after = await request(app).get(`/api/ic/tasks/${taskId}`).expect(200);
      expect(after.body.task.status).toBe("ready");
    });

    it("404s for a task that doesn't exist", async () => {
      await request(app).post("/api/ic/tasks/task_missing/status").send({ status: "blocked" }).expect(404);
    });

    it("400s an invalid status value", async () => {
      const taskId = await seedTask();
      await request(app).post(`/api/ic/tasks/${taskId}/status`).send({ status: "nonsense" }).expect(400);
    });
  });
});

describe("approvals over HTTP", () => {
  it("decides an approval and refuses a second decision", async () => {
    await request(app).post("/api/ic/chat").send({ body: "Bitte überweise 1.000 EUR." });
    const list = await request(app).get("/api/ic/approvals").expect(200);
    const id = list.body.approvals[0].id;

    const decided = await request(app)
      .post(`/api/ic/approvals/${id}/decide`)
      .send({ decision: "approved", reason: "geprüft" })
      .expect(200);
    expect(decided.body.approval.status).toBe("approved");

    await request(app).post(`/api/ic/approvals/${id}/decide`).send({ decision: "rejected" }).expect(409);
  });

  it("rejects an invalid decision value", async () => {
    await request(app).post("/api/ic/chat").send({ body: "Bitte überweise 1.000 EUR." });
    const list = await request(app).get("/api/ic/approvals");
    await request(app)
      .post(`/api/ic/approvals/${list.body.approvals[0].id}/decide`)
      .send({ decision: "maybe" })
      .expect(400);
  });
});

describe("budgets over HTTP", () => {
  it("sets a budget and reports its state", async () => {
    await request(app).put("/api/ic/budgets").send({ scopeType: "company", limitMicros: 1_000_000 }).expect(200);
    const res = await request(app).get("/api/ic/budgets").expect(200);
    expect(res.body.budgets[0].state).toBe("ok");
  });

  it("returns 402 when a hard budget blocks execution", async () => {
    await request(app).put("/api/ic/budgets").send({ scopeType: "company", limitMicros: 1 });
    orchestrator.budgets.recordCost({ companyId, costMicros: 10_000 });
    await request(app).post("/api/ic/chat").send({ body: "Bitte dokumentiere das Verfahren." });

    const res = await request(app).post("/api/ic/tasks/execute-next").expect(402);
    expect(res.body.error).toBe("budget_exceeded");
  });

  it("rejects a malformed budget", async () => {
    await request(app).put("/api/ic/budgets").send({ scopeType: "galaxy", limitMicros: 5 }).expect(400);
    await request(app).put("/api/ic/budgets").send({ scopeType: "company", limitMicros: -1 }).expect(400);
  });
});

describe("vendor policy over HTTP (enforced server-side)", () => {
  it("exposes the policy", async () => {
    const res = await request(app).get("/api/ic/vendor-policy").expect(200);
    expect(res.body.allowedFamilies).toContain("openai/*");
    expect(res.body.telemetry.enabled).toBe(false);
  });

  it("permits an allowed model", async () => {
    const res = await request(app)
      .post("/api/ic/vendor-policy/check")
      .send({ model: "anthropic/claude-sonnet-4" })
      .expect(200);
    expect(res.body.decision.allowed).toBe(true);
  });

  it("refuses a blocked model with 403, not a silent UI hide", async () => {
    for (const model of [
      "deepseek/deepseek-chat",
      "qwen/qwen-2.5-72b-instruct",
      "moonshotai/kimi-k2",
      "z-ai/glm-4.6",
      "01-ai/yi-large",
    ]) {
      const res = await request(app).post("/api/ic/vendor-policy/check").send({ model }).expect(403);
      expect(res.body.decision.allowed).toBe(false);
      expect(res.body.decision.code).toBe("blocked_family");
    }
  });

  it("refuses an unknown vendor by default", async () => {
    const res = await request(app).post("/api/ic/vendor-policy/check").send({ model: "mystery/model-x" }).expect(403);
    expect(res.body.decision.code).toBe("not_in_allowlist");
  });

  it("filters a catalogue server-side", async () => {
    const res = await request(app)
      .post("/api/ic/vendor-policy/filter")
      .send({ models: [{ id: "openai/gpt-4o" }, { id: "deepseek/deepseek-r1" }] })
      .expect(200);
    expect(res.body.allowed).toHaveLength(1);
    expect(res.body.denied).toHaveLength(1);
  });
});

describe("audit and dashboard", () => {
  it("returns the audit trail with a valid chain", async () => {
    await request(app).post("/api/ic/chat").send({ body: "Bitte dokumentiere das Verfahren." });
    const res = await request(app).get("/api/ic/audit").expect(200);
    expect(res.body.chain.valid).toBe(true);
    expect(res.body.events.length).toBeGreaterThan(0);
  });

  it("returns dashboard figures with provenance", async () => {
    await request(app).post("/api/ic/chat").send({ body: "Bitte dokumentiere das Verfahren." });
    const res = await request(app).get("/api/ic/dashboard").expect(200);
    expect(res.body.source).toContain("live");
    expect(res.body.generatedAt).toBeGreaterThan(0);
    expect(res.body.tasks.total).toBe(1);
    expect(res.body.auditChainValid).toBe(true);
  });

  it("counts pending approvals on the dashboard", async () => {
    await request(app).post("/api/ic/chat").send({ body: "Bitte überweise 1.000 EUR." });
    const res = await request(app).get("/api/ic/dashboard").expect(200);
    expect(res.body.approvalsPending).toBe(1);
    expect(res.body.tasks.approvalRequired).toBe(1);
  });
});

describe("agent shape is consistent across endpoints", () => {
  it("returns the same camelCase shape from /chat as from /agents", async () => {
    const listed = await request(app).get("/api/ic/agents").expect(200);
    const chat = await request(app)
      .post("/api/ic/chat")
      .send({ body: "Bitte dokumentiere das Backup-Verfahren." })
      .expect(201);

    const assigned = chat.body.assignedAgent;
    expect(assigned).not.toBeNull();
    // A raw database row would expose display_name / policy_json instead.
    expect(assigned.displayName).toBeTruthy();
    expect(assigned.display_name).toBeUndefined();
    expect(assigned.policy_json).toBeUndefined();
    expect(Object.keys(assigned).sort()).toEqual(Object.keys(listed.body.agents[0]).sort());
  });
});

describe("runtime providers", () => {
  it("lists every registered runtime with its capabilities, health and auth", async () => {
    const res = await request(app).get("/api/ic/runtimes").expect(200);
    expect(res.body.runtimes).toHaveLength(1);
    const mock = res.body.runtimes[0];
    expect(mock.type).toBe("mock");
    expect(mock.health.healthy).toBe(true);
    expect(mock.auth.authenticated).toBe(true);
    expect(mock.capabilities.streaming).toBe(true);
  });

  it("lets an operator select a registered runtime for an agent", async () => {
    const agents = await request(app).get("/api/ic/agents").expect(200);
    const finance = agents.body.agents.find((a: { key: string }) => a.key === "finance");

    const res = await request(app)
      .patch(`/api/ic/agents/${finance.id}/runtime`)
      .send({ runtimeProvider: "mock" })
      .expect(200);
    expect(res.body.agent.runtimeProvider).toBe("mock");
    expect(broadcasts.some((b) => b.type === "ic_agent_changed")).toBe(true);

    const audit = await request(app).get("/api/ic/audit").expect(200);
    expect(audit.body.events.some((e: { action: string }) => e.action === "agent.runtime_changed")).toBe(true);
  });

  it("refuses a runtime that isn't registered", async () => {
    const agents = await request(app).get("/api/ic/agents").expect(200);
    const finance = agents.body.agents.find((a: { key: string }) => a.key === "finance");

    const res = await request(app)
      .patch(`/api/ic/agents/${finance.id}/runtime`)
      .send({ runtimeProvider: "claude" })
      .expect(400);
    expect(res.body.error).toBe("unknown_runtime");
    expect(res.body.registered).toEqual(["mock"]);
  });

  it("404s for an agent that doesn't exist", async () => {
    await request(app).patch("/api/ic/agents/agt_nope/runtime").send({ runtimeProvider: "mock" }).expect(404);
  });
});

describe("goals over HTTP", () => {
  it("creates a goal and reads it back with its ancestry and children", async () => {
    const root = await request(app).post("/api/ic/goals").send({ title: "Grow the company" }).expect(201);
    const child = await request(app)
      .post("/api/ic/goals")
      .send({ title: "Grow revenue 20%", parentId: root.body.goal.id })
      .expect(201);

    const res = await request(app).get(`/api/ic/goals/${child.body.goal.id}`).expect(200);
    expect(res.body.goal.title).toBe("Grow revenue 20%");
    expect(res.body.ancestry.map((g: { title: string }) => g.title)).toEqual(["Grow the company", "Grow revenue 20%"]);
    expect(res.body.children).toEqual([]);

    const rootRes = await request(app).get(`/api/ic/goals/${root.body.goal.id}`).expect(200);
    expect(rootRes.body.children.map((g: { id: string }) => g.id)).toEqual([child.body.goal.id]);
  });

  it("lists top-level goals only when topLevel=true", async () => {
    const root = await request(app).post("/api/ic/goals").send({ title: "root" }).expect(201);
    await request(app).post("/api/ic/goals").send({ title: "child", parentId: root.body.goal.id }).expect(201);

    const res = await request(app).get("/api/ic/goals?topLevel=true").expect(200);
    expect(res.body.goals.map((g: { id: string }) => g.id)).toEqual([root.body.goal.id]);
  });

  it("filters goals by status", async () => {
    const a = await request(app).post("/api/ic/goals").send({ title: "A" }).expect(201);
    await request(app).post(`/api/ic/goals/${a.body.goal.id}/status`).send({ status: "on_hold" }).expect(200);
    await request(app).post("/api/ic/goals").send({ title: "B" }).expect(201);

    const res = await request(app).get("/api/ic/goals?status=on_hold").expect(200);
    expect(res.body.goals.map((g: { id: string }) => g.id)).toEqual([a.body.goal.id]);
  });

  it("updates title and description", async () => {
    const g = await request(app).post("/api/ic/goals").send({ title: "old" }).expect(201);
    const res = await request(app)
      .patch(`/api/ic/goals/${g.body.goal.id}`)
      .send({ title: "new", description: "why" })
      .expect(200);
    expect(res.body.goal.title).toBe("new");
    expect(res.body.goal.description).toBe("why");
    expect(broadcasts.some((b) => b.type === "ic_goal_changed")).toBe(true);
  });

  it("moves a goal through its status transitions", async () => {
    const g = await request(app).post("/api/ic/goals").send({ title: "A" }).expect(201);
    const res = await request(app)
      .post(`/api/ic/goals/${g.body.goal.id}/status`)
      .send({ status: "achieved" })
      .expect(200);
    expect(res.body.goal.status).toBe("achieved");
  });

  it("rejects an illegal status transition with 409", async () => {
    const g = await request(app).post("/api/ic/goals").send({ title: "A" }).expect(201);
    await request(app).post(`/api/ic/goals/${g.body.goal.id}/status`).send({ status: "achieved" }).expect(200);
    const res = await request(app)
      .post(`/api/ic/goals/${g.body.goal.id}/status`)
      .send({ status: "active" })
      .expect(409);
    expect(res.body.error).toBe("invalid_goal_transition");
  });

  it("reparents a goal", async () => {
    const a = await request(app).post("/api/ic/goals").send({ title: "A" }).expect(201);
    const b = await request(app).post("/api/ic/goals").send({ title: "B" }).expect(201);
    const res = await request(app)
      .post(`/api/ic/goals/${b.body.goal.id}/reparent`)
      .send({ parentId: a.body.goal.id })
      .expect(200);
    expect(res.body.goal.parent_id).toBe(a.body.goal.id);
  });

  it("rejects a reparent that would create a cycle with 400", async () => {
    const root = await request(app).post("/api/ic/goals").send({ title: "root" }).expect(201);
    const child = await request(app)
      .post("/api/ic/goals")
      .send({ title: "child", parentId: root.body.goal.id })
      .expect(201);
    const res = await request(app)
      .post(`/api/ic/goals/${root.body.goal.id}/reparent`)
      .send({ parentId: child.body.goal.id })
      .expect(400);
    expect(res.body.error).toBe("invalid_goal_mutation");
  });

  it("404s for a goal that doesn't exist", async () => {
    await request(app).get("/api/ic/goals/goal_nope").expect(404);
    await request(app).patch("/api/ic/goals/goal_nope").send({ title: "x" }).expect(404);
    await request(app).post("/api/ic/goals/goal_nope/status").send({ status: "achieved" }).expect(404);
  });

  it("400s an unknown status filter", async () => {
    await request(app).get("/api/ic/goals?status=nonsense").expect(400);
  });
});

describe("projects and milestones over HTTP", () => {
  it("creates a project with a slugified key and reads it back with the detail view", async () => {
    const created = await request(app).post("/api/ic/projects").send({ title: "Website Relaunch" }).expect(201);
    expect(created.body.project.key).toBe("website-relaunch");
    expect(created.body.project.status).toBe("active");

    const res = await request(app).get(`/api/ic/projects/${created.body.project.id}`).expect(200);
    expect(res.body.project.title).toBe("Website Relaunch");
    expect(res.body.milestones).toEqual([]);
    expect(res.body.tasks).toEqual([]);
  });

  it("links a project to a goal", async () => {
    const goal = await request(app).post("/api/ic/goals").send({ title: "Grow revenue" }).expect(201);
    const project = await request(app)
      .post("/api/ic/projects")
      .send({ title: "Pricing page", goalId: goal.body.goal.id })
      .expect(201);
    expect(project.body.project.goal_id).toBe(goal.body.goal.id);
  });

  it("404s creating a project against a goal that doesn't exist", async () => {
    await request(app).post("/api/ic/projects").send({ title: "x", goalId: "goal_nope" }).expect(400);
  });

  it("lists projects filtered by status and by goal", async () => {
    const goal = await request(app).post("/api/ic/goals").send({ title: "Grow revenue" }).expect(201);
    const a = await request(app).post("/api/ic/projects").send({ title: "A", goalId: goal.body.goal.id }).expect(201);
    await request(app).post(`/api/ic/projects/${a.body.project.id}/status`).send({ status: "on_hold" }).expect(200);
    await request(app).post("/api/ic/projects").send({ title: "B" }).expect(201);

    const byStatus = await request(app).get("/api/ic/projects?status=on_hold").expect(200);
    expect(byStatus.body.projects.map((p: { id: string }) => p.id)).toEqual([a.body.project.id]);

    const byGoal = await request(app).get(`/api/ic/projects?goalId=${goal.body.goal.id}`).expect(200);
    expect(byGoal.body.projects.map((p: { id: string }) => p.id)).toEqual([a.body.project.id]);
  });

  it("updates a project's title and summary", async () => {
    const p = await request(app).post("/api/ic/projects").send({ title: "old" }).expect(201);
    const res = await request(app)
      .patch(`/api/ic/projects/${p.body.project.id}`)
      .send({ title: "new", summary: "why" })
      .expect(200);
    expect(res.body.project.title).toBe("new");
    expect(res.body.project.summary).toBe("why");
    expect(broadcasts.some((b) => b.type === "ic_project_changed")).toBe(true);
  });

  it("moves a project through draft -> active -> done", async () => {
    const p = await request(app).post("/api/ic/projects").send({ title: "A" }).expect(201);
    const res = await request(app)
      .post(`/api/ic/projects/${p.body.project.id}/status`)
      .send({ status: "done" })
      .expect(200);
    expect(res.body.project.status).toBe("done");
  });

  it("rejects an illegal project status transition with 409", async () => {
    const p = await request(app).post("/api/ic/projects").send({ title: "A" }).expect(201);
    await request(app).post(`/api/ic/projects/${p.body.project.id}/status`).send({ status: "done" }).expect(200);
    const res = await request(app)
      .post(`/api/ic/projects/${p.body.project.id}/status`)
      .send({ status: "active" })
      .expect(409);
    expect(res.body.error).toBe("invalid_project_transition");
  });

  it("404s for a project that doesn't exist", async () => {
    await request(app).get("/api/ic/projects/prj_nope").expect(404);
    await request(app).patch("/api/ic/projects/prj_nope").send({ title: "x" }).expect(404);
  });

  it("adds a milestone and surfaces it in the project detail view", async () => {
    const p = await request(app).post("/api/ic/projects").send({ title: "Website Relaunch" }).expect(201);
    const m = await request(app)
      .post(`/api/ic/projects/${p.body.project.id}/milestones`)
      .send({ title: "Design freeze", dueAt: 1234 })
      .expect(201);
    expect(m.body.milestone.project_id).toBe(p.body.project.id);
    expect(m.body.milestone.status).toBe("pending");

    const detail = await request(app).get(`/api/ic/projects/${p.body.project.id}`).expect(200);
    expect(detail.body.milestones.map((x: { id: string }) => x.id)).toEqual([m.body.milestone.id]);
  });

  it("404s adding a milestone to a project that doesn't exist", async () => {
    await request(app).post("/api/ic/projects/prj_nope/milestones").send({ title: "x" }).expect(404);
  });

  it("updates and transitions a milestone", async () => {
    const p = await request(app).post("/api/ic/projects").send({ title: "A" }).expect(201);
    const m = await request(app)
      .post(`/api/ic/projects/${p.body.project.id}/milestones`)
      .send({ title: "old" })
      .expect(201);

    const updated = await request(app)
      .patch(`/api/ic/milestones/${m.body.milestone.id}`)
      .send({ title: "new" })
      .expect(200);
    expect(updated.body.milestone.title).toBe("new");

    const done = await request(app)
      .post(`/api/ic/milestones/${m.body.milestone.id}/status`)
      .send({ status: "done" })
      .expect(200);
    expect(done.body.milestone.status).toBe("done");
    expect(done.body.milestone.completed_at).not.toBeNull();
  });

  it("rejects an illegal milestone status transition with 409", async () => {
    const p = await request(app).post("/api/ic/projects").send({ title: "A" }).expect(201);
    const m = await request(app)
      .post(`/api/ic/projects/${p.body.project.id}/milestones`)
      .send({ title: "x" })
      .expect(201);
    await request(app).post(`/api/ic/milestones/${m.body.milestone.id}/status`).send({ status: "done" }).expect(200);
    const res = await request(app)
      .post(`/api/ic/milestones/${m.body.milestone.id}/status`)
      .send({ status: "pending" })
      .expect(409);
    expect(res.body.error).toBe("invalid_milestone_transition");
  });

  it("404s for a milestone that doesn't exist", async () => {
    await request(app).patch("/api/ic/milestones/mile_nope").send({ title: "x" }).expect(404);
    await request(app).post("/api/ic/milestones/mile_nope/status").send({ status: "done" }).expect(404);
  });
});
