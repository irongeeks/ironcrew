import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import type { DatabaseSync } from "node:sqlite";
import { createTestDb } from "../domain/test-db.ts";
import { registerIronCrewRoutes } from "./routes.ts";
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
  const api = registerIronCrewRoutes(app, {
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
    const res = await request(app).get("/api/crew/company").expect(200);
    expect(res.body.company.id).toBe(companyId);
    expect(res.body.departments.length).toBeGreaterThan(5);
  });

  it("returns agents with persona and policy kept separate", async () => {
    const res = await request(app).get("/api/crew/agents").expect(200);
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
      .post("/api/crew/chat")
      .send({ body: "Bitte dokumentiere das Deployment-Verfahren." })
      .expect(201);
    expect(res.body.triage.category).toBe("simple_task");
    expect(res.body.task.status).toBe("ready");
    expect(res.body.reply).toBeTruthy();
  });

  it("broadcasts the reply and the task change", async () => {
    await request(app).post("/api/crew/chat").send({ body: "Bitte erstelle eine Übersicht." }).expect(201);
    expect(broadcasts.map((b) => b.type)).toEqual(expect.arrayContaining(["crew_chat_message", "crew_task_changed"]));
  });

  it("rejects an empty message", async () => {
    const res = await request(app).post("/api/crew/chat").send({ body: "" }).expect(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("rejects a missing body", async () => {
    await request(app).post("/api/crew/chat").send({}).expect(400);
  });

  it("returns the conversation history", async () => {
    await request(app).post("/api/crew/chat").send({ body: "Bitte analysiere die Logs." });
    const res = await request(app).get("/api/crew/chat").expect(200);
    expect(res.body.messages).toHaveLength(2);
  });

  it("blocks a sensitive request at the API, not just in the UI", async () => {
    const res = await request(app)
      .post("/api/crew/chat")
      .send({ body: "Bitte überweise 5.000 EUR an den Lieferanten." })
      .expect(201);
    expect(res.body.task.status).toBe("approval_required");
    expect(res.body.assignedAgent).toBeNull();

    const approvals = await request(app).get("/api/crew/approvals").expect(200);
    expect(approvals.body.approvals[0].approval_type).toBe("bank_transfer");
  });
});

describe("task lifecycle over HTTP", () => {
  async function seedTask() {
    const res = await request(app)
      .post("/api/crew/chat")
      .send({ body: "Bitte dokumentiere das Backup-Verfahren." })
      .expect(201);
    return res.body.task.id as string;
  }

  it("executes, reviews and accepts a task", async () => {
    const taskId = await seedTask();

    const exec = await request(app).post("/api/crew/tasks/execute-next").expect(200);
    expect(exec.body.executed).toBe(true);
    expect(exec.body.task.status).toBe("review");

    const accepted = await request(app).post(`/api/crew/tasks/${taskId}/accept`).send({ note: "Passt." }).expect(200);
    expect(accepted.body.task.status).toBe("done");
  });

  it("supports requesting a revision", async () => {
    const taskId = await seedTask();
    await request(app).post("/api/crew/tasks/execute-next").expect(200);

    const revised = await request(app)
      .post(`/api/crew/tasks/${taskId}/revise`)
      .send({ reason: "Bitte mit mehr Details." })
      .expect(200);
    expect(revised.body.task.status).toBe("ready");
  });

  it("rejects a revision without a reason", async () => {
    const taskId = await seedTask();
    await request(app).post("/api/crew/tasks/execute-next");
    await request(app).post(`/api/crew/tasks/${taskId}/revise`).send({}).expect(400);
  });

  it("refuses to accept a task that is not in review", async () => {
    const taskId = await seedTask();
    const res = await request(app).post(`/api/crew/tasks/${taskId}/accept`).send({}).expect(409);
    expect(res.body.error).toBe("cannot_accept");
  });

  it("reports when nothing is claimable", async () => {
    const res = await request(app).post("/api/crew/tasks/execute-next").expect(200);
    expect(res.body.executed).toBe(false);
  });

  it("broadcasts run events during execution", async () => {
    await seedTask();
    await request(app).post("/api/crew/tasks/execute-next").expect(200);
    const runEvents = broadcasts.filter((b) => b.type === "crew_run_event");
    expect(runEvents.length).toBeGreaterThan(3);
  });

  it("returns task detail with runs and audit trail", async () => {
    const taskId = await seedTask();
    await request(app).post("/api/crew/tasks/execute-next");
    const res = await request(app).get(`/api/crew/tasks/${taskId}`).expect(200);
    expect(res.body.runs).toHaveLength(1);
    expect(res.body.audit.length).toBeGreaterThan(0);
  });

  it("404s for an unknown task", async () => {
    await request(app).get("/api/crew/tasks/task_missing").expect(404);
  });

  it("validates the status filter", async () => {
    await request(app).get("/api/crew/tasks?status=nonsense").expect(400);
    await request(app).get("/api/crew/tasks?status=ready").expect(200);
  });

  it("replays run events", async () => {
    await seedTask();
    const exec = await request(app).post("/api/crew/tasks/execute-next");
    const res = await request(app).get(`/api/crew/runs/${exec.body.runId}/events`).expect(200);
    expect(res.body.events.length).toBe(exec.body.eventCount);
    expect(res.body.events[0].type).toBe("run.started");
  });

  describe("generic status move (Kanban drag & drop)", () => {
    it("moves a task along a legal transition", async () => {
      const taskId = await seedTask();
      const res = await request(app).post(`/api/crew/tasks/${taskId}/status`).send({ status: "blocked" }).expect(200);
      expect(res.body.task.status).toBe("blocked");
      expect(broadcasts.some((b) => b.type === "crew_task_changed")).toBe(true);
    });

    it("rejects an illegal transition with 409, never applying it", async () => {
      const taskId = await seedTask();
      const res = await request(app).post(`/api/crew/tasks/${taskId}/status`).send({ status: "done" }).expect(409);
      expect(res.body.error).toBe("invalid_transition");

      const after = await request(app).get(`/api/crew/tasks/${taskId}`).expect(200);
      expect(after.body.task.status).toBe("ready");
    });

    it("404s for a task that doesn't exist", async () => {
      await request(app).post("/api/crew/tasks/task_missing/status").send({ status: "blocked" }).expect(404);
    });

    it("400s an invalid status value", async () => {
      const taskId = await seedTask();
      await request(app).post(`/api/crew/tasks/${taskId}/status`).send({ status: "nonsense" }).expect(400);
    });
  });

  describe("task dependencies", () => {
    function pair() {
      const dependent = orchestrator.tasks.create({ companyId, title: "dependent", status: "ready" });
      const blocker = orchestrator.tasks.create({ companyId, title: "blocker", status: "ready" });
      return { dependent, blocker };
    }

    it("adds a dependency and surfaces it on both sides", async () => {
      const { dependent, blocker } = pair();
      const res = await request(app)
        .post(`/api/crew/tasks/${dependent.id}/dependencies`)
        .send({ dependsOnId: blocker.id })
        .expect(201);
      expect(res.body.blockers.map((t: { id: string }) => t.id)).toEqual([blocker.id]);

      const detail = await request(app).get(`/api/crew/tasks/${dependent.id}`).expect(200);
      expect(detail.body.blockers.map((t: { id: string }) => t.id)).toEqual([blocker.id]);

      const blockerDetail = await request(app).get(`/api/crew/tasks/${blocker.id}`).expect(200);
      expect(blockerDetail.body.blocking.map((t: { id: string }) => t.id)).toEqual([dependent.id]);
    });

    it("rejects a cycle with 400", async () => {
      const { dependent, blocker } = pair();
      await request(app)
        .post(`/api/crew/tasks/${dependent.id}/dependencies`)
        .send({ dependsOnId: blocker.id })
        .expect(201);
      const res = await request(app)
        .post(`/api/crew/tasks/${blocker.id}/dependencies`)
        .send({ dependsOnId: dependent.id })
        .expect(400);
      expect(res.body.error).toBe("invalid_task_dependency");
    });

    it("404s when the target task doesn't exist", async () => {
      const { dependent } = pair();
      await request(app)
        .post(`/api/crew/tasks/${dependent.id}/dependencies`)
        .send({ dependsOnId: "task_missing" })
        .expect(404);
    });

    it("removes a dependency", async () => {
      const { dependent, blocker } = pair();
      await request(app)
        .post(`/api/crew/tasks/${dependent.id}/dependencies`)
        .send({ dependsOnId: blocker.id })
        .expect(201);

      const res = await request(app).delete(`/api/crew/tasks/${dependent.id}/dependencies/${blocker.id}`).expect(200);
      expect(res.body.blockers).toEqual([]);
    });

    it("404s for a task that doesn't exist when adding or removing", async () => {
      const { blocker } = pair();
      await request(app)
        .post("/api/crew/tasks/task_missing/dependencies")
        .send({ dependsOnId: blocker.id })
        .expect(404);
      await request(app).delete(`/api/crew/tasks/task_missing/dependencies/${blocker.id}`).expect(404);
    });
  });
});

describe("approvals over HTTP", () => {
  it("decides an approval and refuses a second decision", async () => {
    await request(app).post("/api/crew/chat").send({ body: "Bitte überweise 1.000 EUR." });
    const list = await request(app).get("/api/crew/approvals").expect(200);
    const id = list.body.approvals[0].id;

    const decided = await request(app)
      .post(`/api/crew/approvals/${id}/decide`)
      .send({ decision: "approved", reason: "geprüft" })
      .expect(200);
    expect(decided.body.approval.status).toBe("approved");

    await request(app).post(`/api/crew/approvals/${id}/decide`).send({ decision: "rejected" }).expect(409);
  });

  it("rejects an invalid decision value", async () => {
    await request(app).post("/api/crew/chat").send({ body: "Bitte überweise 1.000 EUR." });
    const list = await request(app).get("/api/crew/approvals");
    await request(app)
      .post(`/api/crew/approvals/${list.body.approvals[0].id}/decide`)
      .send({ decision: "maybe" })
      .expect(400);
  });

  it("records a decision and clears the inbox notification when decided over HTTP", async () => {
    await request(app).post("/api/crew/chat").send({ body: "Bitte überweise 1.000 EUR." });
    const approvals = await request(app).get("/api/crew/approvals").expect(200);
    const approvalId = approvals.body.approvals[0].id;

    const before = await request(app).get("/api/crew/notifications?unread=true").expect(200);
    expect(before.body.notifications).toHaveLength(1);

    await request(app)
      .post(`/api/crew/approvals/${approvalId}/decide`)
      .send({ decision: "approved", reason: "geprüft" })
      .expect(200);

    const decisions = await request(app).get("/api/crew/decisions").expect(200);
    expect(decisions.body.decisions).toHaveLength(1);
    expect(decisions.body.decisions[0].decision).toBe("approved");

    const after = await request(app).get("/api/crew/notifications?unread=true").expect(200);
    expect(after.body.notifications).toHaveLength(0);
  });
});

describe("decision inbox over HTTP", () => {
  it("lists notifications newest first with an unread count", async () => {
    await request(app).post("/api/crew/chat").send({ body: "Bitte überweise 1.000 EUR." });
    const res = await request(app).get("/api/crew/notifications").expect(200);
    expect(res.body.notifications).toHaveLength(1);
    expect(res.body.notifications[0].kind).toBe("approval_required");
    expect(res.body.unreadCount).toBe(1);
  });

  it("marks a notification read", async () => {
    await request(app).post("/api/crew/chat").send({ body: "Bitte überweise 1.000 EUR." });
    const list = await request(app).get("/api/crew/notifications").expect(200);
    const id = list.body.notifications[0].id;

    const res = await request(app).post(`/api/crew/notifications/${id}/read`).expect(200);
    expect(res.body.notification.read_at).not.toBeNull();
    expect(broadcasts.some((b) => b.type === "crew_notification_read")).toBe(true);

    const unread = await request(app).get("/api/crew/notifications?unread=true").expect(200);
    expect(unread.body.notifications).toHaveLength(0);
  });

  it("404s marking a notification that doesn't exist", async () => {
    await request(app).post("/api/crew/notifications/ntf_nope/read").expect(404);
  });

  it("lists decisions, empty until one is recorded", async () => {
    const res = await request(app).get("/api/crew/decisions").expect(200);
    expect(res.body.decisions).toEqual([]);
  });
});

describe("budgets over HTTP", () => {
  it("sets a budget and reports its state", async () => {
    await request(app).put("/api/crew/budgets").send({ scopeType: "company", limitMicros: 1_000_000 }).expect(200);
    const res = await request(app).get("/api/crew/budgets").expect(200);
    expect(res.body.budgets[0].state).toBe("ok");
  });

  it("returns 402 when a hard budget blocks execution", async () => {
    await request(app).put("/api/crew/budgets").send({ scopeType: "company", limitMicros: 1 });
    orchestrator.budgets.recordCost({ companyId, costMicros: 10_000 });
    await request(app).post("/api/crew/chat").send({ body: "Bitte dokumentiere das Verfahren." });

    const res = await request(app).post("/api/crew/tasks/execute-next").expect(402);
    expect(res.body.error).toBe("budget_exceeded");
  });

  it("rejects a malformed budget", async () => {
    await request(app).put("/api/crew/budgets").send({ scopeType: "galaxy", limitMicros: 5 }).expect(400);
    await request(app).put("/api/crew/budgets").send({ scopeType: "company", limitMicros: -1 }).expect(400);
  });
});

describe("vendor policy over HTTP (enforced server-side)", () => {
  it("exposes the policy", async () => {
    const res = await request(app).get("/api/crew/vendor-policy").expect(200);
    expect(res.body.allowedFamilies).toContain("openai/*");
    expect(res.body.telemetry.enabled).toBe(false);
  });

  it("permits an allowed model", async () => {
    const res = await request(app)
      .post("/api/crew/vendor-policy/check")
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
      const res = await request(app).post("/api/crew/vendor-policy/check").send({ model }).expect(403);
      expect(res.body.decision.allowed).toBe(false);
      expect(res.body.decision.code).toBe("blocked_family");
    }
  });

  it("refuses an unknown vendor by default", async () => {
    const res = await request(app).post("/api/crew/vendor-policy/check").send({ model: "mystery/model-x" }).expect(403);
    expect(res.body.decision.code).toBe("not_in_allowlist");
  });

  it("filters a catalogue server-side", async () => {
    const res = await request(app)
      .post("/api/crew/vendor-policy/filter")
      .send({ models: [{ id: "openai/gpt-4o" }, { id: "deepseek/deepseek-r1" }] })
      .expect(200);
    expect(res.body.allowed).toHaveLength(1);
    expect(res.body.denied).toHaveLength(1);
  });
});

describe("audit and dashboard", () => {
  it("returns the audit trail with a valid chain", async () => {
    await request(app).post("/api/crew/chat").send({ body: "Bitte dokumentiere das Verfahren." });
    const res = await request(app).get("/api/crew/audit").expect(200);
    expect(res.body.chain.valid).toBe(true);
    expect(res.body.events.length).toBeGreaterThan(0);
  });

  it("returns dashboard figures with provenance", async () => {
    await request(app).post("/api/crew/chat").send({ body: "Bitte dokumentiere das Verfahren." });
    const res = await request(app).get("/api/crew/dashboard").expect(200);
    expect(res.body.source).toContain("live");
    expect(res.body.generatedAt).toBeGreaterThan(0);
    expect(res.body.tasks.total).toBe(1);
    expect(res.body.auditChainValid).toBe(true);
  });

  it("counts pending approvals on the dashboard", async () => {
    await request(app).post("/api/crew/chat").send({ body: "Bitte überweise 1.000 EUR." });
    const res = await request(app).get("/api/crew/dashboard").expect(200);
    expect(res.body.approvalsPending).toBe(1);
    expect(res.body.tasks.approvalRequired).toBe(1);
  });
});

describe("agent shape is consistent across endpoints", () => {
  it("returns the same camelCase shape from /chat as from /agents", async () => {
    const listed = await request(app).get("/api/crew/agents").expect(200);
    const chat = await request(app)
      .post("/api/crew/chat")
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
    const res = await request(app).get("/api/crew/runtimes").expect(200);
    expect(res.body.runtimes).toHaveLength(1);
    const mock = res.body.runtimes[0];
    expect(mock.type).toBe("mock");
    expect(mock.health.healthy).toBe(true);
    expect(mock.auth.authenticated).toBe(true);
    expect(mock.capabilities.streaming).toBe(true);
  });

  it("lets an operator select a registered runtime for an agent", async () => {
    const agents = await request(app).get("/api/crew/agents").expect(200);
    const finance = agents.body.agents.find((a: { key: string }) => a.key === "finance");

    const res = await request(app)
      .patch(`/api/crew/agents/${finance.id}/runtime`)
      .send({ runtimeProvider: "mock" })
      .expect(200);
    expect(res.body.agent.runtimeProvider).toBe("mock");
    expect(broadcasts.some((b) => b.type === "crew_agent_changed")).toBe(true);

    const audit = await request(app).get("/api/crew/audit").expect(200);
    expect(audit.body.events.some((e: { action: string }) => e.action === "agent.runtime_changed")).toBe(true);
  });

  it("refuses a runtime that isn't registered", async () => {
    const agents = await request(app).get("/api/crew/agents").expect(200);
    const finance = agents.body.agents.find((a: { key: string }) => a.key === "finance");

    const res = await request(app)
      .patch(`/api/crew/agents/${finance.id}/runtime`)
      .send({ runtimeProvider: "claude" })
      .expect(400);
    expect(res.body.error).toBe("unknown_runtime");
    expect(res.body.registered).toEqual(["mock"]);
  });

  it("404s for an agent that doesn't exist", async () => {
    await request(app).patch("/api/crew/agents/agt_nope/runtime").send({ runtimeProvider: "mock" }).expect(404);
  });
});

describe("goals over HTTP", () => {
  it("creates a goal and reads it back with its ancestry and children", async () => {
    const root = await request(app).post("/api/crew/goals").send({ title: "Grow the company" }).expect(201);
    const child = await request(app)
      .post("/api/crew/goals")
      .send({ title: "Grow revenue 20%", parentId: root.body.goal.id })
      .expect(201);

    const res = await request(app).get(`/api/crew/goals/${child.body.goal.id}`).expect(200);
    expect(res.body.goal.title).toBe("Grow revenue 20%");
    expect(res.body.ancestry.map((g: { title: string }) => g.title)).toEqual(["Grow the company", "Grow revenue 20%"]);
    expect(res.body.children).toEqual([]);

    const rootRes = await request(app).get(`/api/crew/goals/${root.body.goal.id}`).expect(200);
    expect(rootRes.body.children.map((g: { id: string }) => g.id)).toEqual([child.body.goal.id]);
  });

  it("lists top-level goals only when topLevel=true", async () => {
    const root = await request(app).post("/api/crew/goals").send({ title: "root" }).expect(201);
    await request(app).post("/api/crew/goals").send({ title: "child", parentId: root.body.goal.id }).expect(201);

    const res = await request(app).get("/api/crew/goals?topLevel=true").expect(200);
    expect(res.body.goals.map((g: { id: string }) => g.id)).toEqual([root.body.goal.id]);
  });

  it("filters goals by status", async () => {
    const a = await request(app).post("/api/crew/goals").send({ title: "A" }).expect(201);
    await request(app).post(`/api/crew/goals/${a.body.goal.id}/status`).send({ status: "on_hold" }).expect(200);
    await request(app).post("/api/crew/goals").send({ title: "B" }).expect(201);

    const res = await request(app).get("/api/crew/goals?status=on_hold").expect(200);
    expect(res.body.goals.map((g: { id: string }) => g.id)).toEqual([a.body.goal.id]);
  });

  it("updates title and description", async () => {
    const g = await request(app).post("/api/crew/goals").send({ title: "old" }).expect(201);
    const res = await request(app)
      .patch(`/api/crew/goals/${g.body.goal.id}`)
      .send({ title: "new", description: "why" })
      .expect(200);
    expect(res.body.goal.title).toBe("new");
    expect(res.body.goal.description).toBe("why");
    expect(broadcasts.some((b) => b.type === "crew_goal_changed")).toBe(true);
  });

  it("moves a goal through its status transitions", async () => {
    const g = await request(app).post("/api/crew/goals").send({ title: "A" }).expect(201);
    const res = await request(app)
      .post(`/api/crew/goals/${g.body.goal.id}/status`)
      .send({ status: "achieved" })
      .expect(200);
    expect(res.body.goal.status).toBe("achieved");
  });

  it("rejects an illegal status transition with 409", async () => {
    const g = await request(app).post("/api/crew/goals").send({ title: "A" }).expect(201);
    await request(app).post(`/api/crew/goals/${g.body.goal.id}/status`).send({ status: "achieved" }).expect(200);
    const res = await request(app)
      .post(`/api/crew/goals/${g.body.goal.id}/status`)
      .send({ status: "active" })
      .expect(409);
    expect(res.body.error).toBe("invalid_goal_transition");
  });

  it("reparents a goal", async () => {
    const a = await request(app).post("/api/crew/goals").send({ title: "A" }).expect(201);
    const b = await request(app).post("/api/crew/goals").send({ title: "B" }).expect(201);
    const res = await request(app)
      .post(`/api/crew/goals/${b.body.goal.id}/reparent`)
      .send({ parentId: a.body.goal.id })
      .expect(200);
    expect(res.body.goal.parent_id).toBe(a.body.goal.id);
  });

  it("rejects a reparent that would create a cycle with 400", async () => {
    const root = await request(app).post("/api/crew/goals").send({ title: "root" }).expect(201);
    const child = await request(app)
      .post("/api/crew/goals")
      .send({ title: "child", parentId: root.body.goal.id })
      .expect(201);
    const res = await request(app)
      .post(`/api/crew/goals/${root.body.goal.id}/reparent`)
      .send({ parentId: child.body.goal.id })
      .expect(400);
    expect(res.body.error).toBe("invalid_goal_mutation");
  });

  it("404s for a goal that doesn't exist", async () => {
    await request(app).get("/api/crew/goals/goal_nope").expect(404);
    await request(app).patch("/api/crew/goals/goal_nope").send({ title: "x" }).expect(404);
    await request(app).post("/api/crew/goals/goal_nope/status").send({ status: "achieved" }).expect(404);
  });

  it("400s an unknown status filter", async () => {
    await request(app).get("/api/crew/goals?status=nonsense").expect(400);
  });
});

describe("projects and milestones over HTTP", () => {
  it("creates a project with a slugified key and reads it back with the detail view", async () => {
    const created = await request(app).post("/api/crew/projects").send({ title: "Website Relaunch" }).expect(201);
    expect(created.body.project.key).toBe("website-relaunch");
    expect(created.body.project.status).toBe("active");

    const res = await request(app).get(`/api/crew/projects/${created.body.project.id}`).expect(200);
    expect(res.body.project.title).toBe("Website Relaunch");
    expect(res.body.milestones).toEqual([]);
    expect(res.body.tasks).toEqual([]);
  });

  it("links a project to a goal", async () => {
    const goal = await request(app).post("/api/crew/goals").send({ title: "Grow revenue" }).expect(201);
    const project = await request(app)
      .post("/api/crew/projects")
      .send({ title: "Pricing page", goalId: goal.body.goal.id })
      .expect(201);
    expect(project.body.project.goal_id).toBe(goal.body.goal.id);
  });

  it("404s creating a project against a goal that doesn't exist", async () => {
    await request(app).post("/api/crew/projects").send({ title: "x", goalId: "goal_nope" }).expect(400);
  });

  it("lists projects filtered by status and by goal", async () => {
    const goal = await request(app).post("/api/crew/goals").send({ title: "Grow revenue" }).expect(201);
    const a = await request(app).post("/api/crew/projects").send({ title: "A", goalId: goal.body.goal.id }).expect(201);
    await request(app).post(`/api/crew/projects/${a.body.project.id}/status`).send({ status: "on_hold" }).expect(200);
    await request(app).post("/api/crew/projects").send({ title: "B" }).expect(201);

    const byStatus = await request(app).get("/api/crew/projects?status=on_hold").expect(200);
    expect(byStatus.body.projects.map((p: { id: string }) => p.id)).toEqual([a.body.project.id]);

    const byGoal = await request(app).get(`/api/crew/projects?goalId=${goal.body.goal.id}`).expect(200);
    expect(byGoal.body.projects.map((p: { id: string }) => p.id)).toEqual([a.body.project.id]);
  });

  it("updates a project's title and summary", async () => {
    const p = await request(app).post("/api/crew/projects").send({ title: "old" }).expect(201);
    const res = await request(app)
      .patch(`/api/crew/projects/${p.body.project.id}`)
      .send({ title: "new", summary: "why" })
      .expect(200);
    expect(res.body.project.title).toBe("new");
    expect(res.body.project.summary).toBe("why");
    expect(broadcasts.some((b) => b.type === "crew_project_changed")).toBe(true);
  });

  it("moves a project through draft -> active -> done", async () => {
    const p = await request(app).post("/api/crew/projects").send({ title: "A" }).expect(201);
    const res = await request(app)
      .post(`/api/crew/projects/${p.body.project.id}/status`)
      .send({ status: "done" })
      .expect(200);
    expect(res.body.project.status).toBe("done");
  });

  it("rejects an illegal project status transition with 409", async () => {
    const p = await request(app).post("/api/crew/projects").send({ title: "A" }).expect(201);
    await request(app).post(`/api/crew/projects/${p.body.project.id}/status`).send({ status: "done" }).expect(200);
    const res = await request(app)
      .post(`/api/crew/projects/${p.body.project.id}/status`)
      .send({ status: "active" })
      .expect(409);
    expect(res.body.error).toBe("invalid_project_transition");
  });

  it("404s for a project that doesn't exist", async () => {
    await request(app).get("/api/crew/projects/prj_nope").expect(404);
    await request(app).patch("/api/crew/projects/prj_nope").send({ title: "x" }).expect(404);
  });

  it("adds a milestone and surfaces it in the project detail view", async () => {
    const p = await request(app).post("/api/crew/projects").send({ title: "Website Relaunch" }).expect(201);
    const m = await request(app)
      .post(`/api/crew/projects/${p.body.project.id}/milestones`)
      .send({ title: "Design freeze", dueAt: 1234 })
      .expect(201);
    expect(m.body.milestone.project_id).toBe(p.body.project.id);
    expect(m.body.milestone.status).toBe("pending");

    const detail = await request(app).get(`/api/crew/projects/${p.body.project.id}`).expect(200);
    expect(detail.body.milestones.map((x: { id: string }) => x.id)).toEqual([m.body.milestone.id]);
  });

  it("404s adding a milestone to a project that doesn't exist", async () => {
    await request(app).post("/api/crew/projects/prj_nope/milestones").send({ title: "x" }).expect(404);
  });

  it("updates and transitions a milestone", async () => {
    const p = await request(app).post("/api/crew/projects").send({ title: "A" }).expect(201);
    const m = await request(app)
      .post(`/api/crew/projects/${p.body.project.id}/milestones`)
      .send({ title: "old" })
      .expect(201);

    const updated = await request(app)
      .patch(`/api/crew/milestones/${m.body.milestone.id}`)
      .send({ title: "new" })
      .expect(200);
    expect(updated.body.milestone.title).toBe("new");

    const done = await request(app)
      .post(`/api/crew/milestones/${m.body.milestone.id}/status`)
      .send({ status: "done" })
      .expect(200);
    expect(done.body.milestone.status).toBe("done");
    expect(done.body.milestone.completed_at).not.toBeNull();
  });

  it("rejects an illegal milestone status transition with 409", async () => {
    const p = await request(app).post("/api/crew/projects").send({ title: "A" }).expect(201);
    const m = await request(app)
      .post(`/api/crew/projects/${p.body.project.id}/milestones`)
      .send({ title: "x" })
      .expect(201);
    await request(app).post(`/api/crew/milestones/${m.body.milestone.id}/status`).send({ status: "done" }).expect(200);
    const res = await request(app)
      .post(`/api/crew/milestones/${m.body.milestone.id}/status`)
      .send({ status: "pending" })
      .expect(409);
    expect(res.body.error).toBe("invalid_milestone_transition");
  });

  it("404s for a milestone that doesn't exist", async () => {
    await request(app).patch("/api/crew/milestones/mile_nope").send({ title: "x" }).expect(404);
    await request(app).post("/api/crew/milestones/mile_nope/status").send({ status: "done" }).expect(404);
  });
});

describe("secrets over HTTP", () => {
  it("lists providers with their registration + connection status", async () => {
    orchestrator.registerSecretProvider({
      kind: "protonpass",
      resolve: async () => "x",
      testConnection: async () => ({ ok: true, message: "authenticated" }),
    });
    const res = await request(app).get("/api/crew/secret-providers").expect(200);
    const protonpass = res.body.providers.find((p: { kind: string }) => p.kind === "protonpass");
    const vaultwarden = res.body.providers.find((p: { kind: string }) => p.kind === "vaultwarden");
    expect(protonpass).toMatchObject({ registered: true, ok: true, message: "authenticated" });
    expect(vaultwarden).toMatchObject({ registered: false, ok: false });
  });

  it("creates, lists, updates and deletes a secret ref", async () => {
    const created = await request(app)
      .post("/api/crew/secrets")
      .send({ name: "gh-pat", provider: "vaultwarden", itemRef: "github" })
      .expect(201);
    expect(created.body.secret.name).toBe("gh-pat");
    expect(created.body.secret).not.toHaveProperty("value");
    expect(broadcasts.some((b) => b.type === "crew_secret_changed")).toBe(true);

    const list = await request(app).get("/api/crew/secrets").expect(200);
    expect(list.body.secrets).toHaveLength(1);

    const updated = await request(app)
      .patch(`/api/crew/secrets/${created.body.secret.id}`)
      .send({ description: "used by the CI agent" })
      .expect(200);
    expect(updated.body.secret.description).toBe("used by the CI agent");

    await request(app).delete(`/api/crew/secrets/${created.body.secret.id}`).expect(200);
    const afterDelete = await request(app).get("/api/crew/secrets").expect(200);
    expect(afterDelete.body.secrets).toHaveLength(0);
  });

  it("rejects an unknown provider with 400", async () => {
    const res = await request(app)
      .post("/api/crew/secrets")
      .send({ name: "x", provider: "1password", itemRef: "y" })
      .expect(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("rejects a duplicate name with 400", async () => {
    await request(app)
      .post("/api/crew/secrets")
      .send({ name: "dup", provider: "protonpass", itemRef: "s:1" })
      .expect(201);
    const res = await request(app)
      .post("/api/crew/secrets")
      .send({ name: "dup", provider: "protonpass", itemRef: "s:2" })
      .expect(400);
    expect(res.body.error).toBe("invalid_secret_mutation");
  });

  it("404s updating or deleting a secret that doesn't exist", async () => {
    await request(app).patch("/api/crew/secrets/secret_nope").send({ description: "x" }).expect(404);
    await request(app).delete("/api/crew/secrets/secret_nope").expect(404);
  });

  it("test reports ok:true and never leaks the value when resolution succeeds", async () => {
    orchestrator.registerSecretProvider({
      kind: "protonpass",
      resolve: async () => "super-secret-value",
      testConnection: async () => ({ ok: true, message: "ok" }),
    });
    const created = await request(app)
      .post("/api/crew/secrets")
      .send({ name: "gh-pat", provider: "protonpass", itemRef: "s:1" })
      .expect(201);

    const res = await request(app).post(`/api/crew/secrets/${created.body.secret.id}/test`).expect(200);
    expect(res.body).toEqual({ ok: true, length: "super-secret-value".length });
    expect(JSON.stringify(res.body)).not.toMatch(/super-secret-value/);
  });

  it("test reports ok:false with 200 (not a request error) when resolution fails", async () => {
    const created = await request(app)
      .post("/api/crew/secrets")
      .send({ name: "gh-pat", provider: "vaultwarden", itemRef: "github" })
      .expect(201);
    const res = await request(app).post(`/api/crew/secrets/${created.body.secret.id}/test`).expect(200);
    expect(res.body.ok).toBe(false);
  });

  it("404s testing a secret that doesn't exist", async () => {
    await request(app).post("/api/crew/secrets/secret_nope/test").expect(404);
  });
});

describe("attachments over HTTP", () => {
  let attDb: DatabaseSync;
  let attApp: Express;
  let attOrchestrator: CompanyOrchestrator;
  let tmpDir: string;

  beforeEach(async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-attach-http-"));
    attDb = createTestDb();
    attApp = express();
    attApp.use(express.json({ limit: "12mb" }));
    attOrchestrator = new CompanyOrchestrator(attDb, new Map(), tmpDir);
    registerIronCrewRoutes(attApp, { db: attDb, orchestrator: attOrchestrator });
    attApp.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: "internal", message: err.message });
    });
  });

  afterEach(async () => {
    const fs = await import("node:fs");
    attDb.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("uploads a general attachment and downloads it back byte-for-byte", async () => {
    const dataBase64 = Buffer.from("hello ironcrew").toString("base64");
    const uploaded = await request(attApp)
      .post("/api/crew/attachments")
      .send({ filename: "notes.txt", contentType: "text/plain", dataBase64 })
      .expect(201);
    expect(uploaded.body.attachment.filename).toBe("notes.txt");
    expect(uploaded.body.attachment.task_id).toBeNull();

    const list = await request(attApp).get("/api/crew/attachments").expect(200);
    expect(list.body.attachments).toHaveLength(1);

    const download = await request(attApp)
      .get(`/api/crew/attachments/${uploaded.body.attachment.id}/download`)
      .expect(200);
    expect(download.text).toBe("hello ironcrew");
    expect(download.headers["content-type"]).toMatch(/text\/plain/);
    expect(download.headers["content-disposition"]).toMatch(/notes\.txt/);
  });

  it("scopes an attachment to a task and lists it back via ?taskId=", async () => {
    const chat = await request(attApp).post("/api/crew/chat").send({ body: "Bitte dokumentiere das Verfahren." });
    const taskId = chat.body.task.id;
    const dataBase64 = Buffer.from("spec").toString("base64");
    await request(attApp).post("/api/crew/attachments").send({ filename: "spec.pdf", dataBase64, taskId }).expect(201);

    const forTask = await request(attApp).get(`/api/crew/attachments?taskId=${taskId}`).expect(200);
    expect(forTask.body.attachments).toHaveLength(1);
    const general = await request(attApp).get("/api/crew/attachments").expect(200);
    expect(general.body.attachments).toHaveLength(0);
  });

  it("rejects both taskId and projectId set at once with 400", async () => {
    const dataBase64 = Buffer.from("x").toString("base64");
    const res = await request(attApp)
      .post("/api/crew/attachments")
      .send({ filename: "x", dataBase64, taskId: "task_1", projectId: "prj_1" })
      .expect(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("rejects an attachment scoped to a task that doesn't exist", async () => {
    const dataBase64 = Buffer.from("x").toString("base64");
    const res = await request(attApp)
      .post("/api/crew/attachments")
      .send({ filename: "x", dataBase64, taskId: "task_nope" })
      .expect(400);
    expect(res.body.error).toBe("invalid_attachment_mutation");
  });

  it("deletes an attachment", async () => {
    const dataBase64 = Buffer.from("x").toString("base64");
    const uploaded = await request(attApp)
      .post("/api/crew/attachments")
      .send({ filename: "x", dataBase64 })
      .expect(201);
    await request(attApp).delete(`/api/crew/attachments/${uploaded.body.attachment.id}`).expect(200);
    await request(attApp).get(`/api/crew/attachments/${uploaded.body.attachment.id}/download`).expect(404);
  });

  it("404s downloading or deleting an attachment that doesn't exist", async () => {
    await request(attApp).get("/api/crew/attachments/att_nope/download").expect(404);
    await request(attApp).delete("/api/crew/attachments/att_nope").expect(404);
  });
});

describe("tailscale + remote workers over HTTP", () => {
  it("reports tailscale status even when the CLI is unreachable", async () => {
    const res = await request(app).get("/api/crew/tailscale").expect(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.backendState).toBeDefined();
    expect(res.body.peers).toEqual([]);
  });

  it("reports tailscale status via a registered fake provider", async () => {
    orchestrator.registerTailscaleProvider({
      status: async () => ({
        backendState: "Running",
        self: {
          id: "1",
          hostName: "crew-server",
          dnsName: "crew-server.ts.net.",
          tailscaleIPs: ["100.1.1.1"],
          online: true,
          os: "linux",
        },
        peers: [],
      }),
      testConnection: async () => ({ ok: true, message: "verbunden als crew-server (100.1.1.1)" }),
    } as unknown as Parameters<typeof orchestrator.registerTailscaleProvider>[0]);

    const res = await request(app).get("/api/crew/tailscale").expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.backendState).toBe("Running");
    expect(res.body.self.hostName).toBe("crew-server");
  });

  it("creates, lists, tests and deletes a remote worker", async () => {
    // A real `ssh` connect attempt here is exactly what testRemoteWorker()
    // should be proven to drive — but with a genuinely unreachable host, its
    // ConnectTimeout=5 (ssh-connector.ts) races vitest's own default 5000ms
    // test timeout, and behaves very differently by environment (this
    // sandbox fails fast; a CI runner's network stack waited out the full
    // 5s and timed the test out). A fake connector proves the same wiring —
    // the route reaches orchestrator.testRemoteWorker() and returns its
    // {ok, message} — without a real spawn or that race; the fake itself is
    // exercised for real in company.test.ts, and the real spawn path in
    // ssh-connector's own tests.
    const workerDb = createTestDb();
    const workerApp = express();
    workerApp.use(express.json());
    const workerBroadcasts: Array<{ type: string; payload: unknown }> = [];
    const workerOrchestrator = new CompanyOrchestrator(
      workerDb,
      new Map(),
      undefined,
      () =>
        ({
          testConnection: async () => false,
        }) as unknown as ReturnType<typeof import("../../modules/workflow/ssh/ssh-connector.ts").createSshConnector>,
    );
    registerIronCrewRoutes(workerApp, {
      db: workerDb,
      orchestrator: workerOrchestrator,
      broadcast: (type, payload) => workerBroadcasts.push({ type, payload }),
    });

    try {
      const created = await request(workerApp)
        .post("/api/crew/remote-workers")
        .send({
          label: "tier0-acme",
          environment: "customer:acme",
          host: "100.64.1.2",
          sshUser: "deploy",
          privateKeyPath: "/etc/ironcrew/keys/acme.pem",
        })
        .expect(201);
      expect(created.body.remoteWorker.label).toBe("tier0-acme");
      expect(created.body.remoteWorker.port).toBe(22);
      expect(workerBroadcasts.some((b) => b.type === "crew_remote_worker_changed")).toBe(true);

      const list = await request(workerApp).get("/api/crew/remote-workers").expect(200);
      expect(list.body.remoteWorkers).toHaveLength(1);

      const tested = await request(workerApp)
        .post(`/api/crew/remote-workers/${created.body.remoteWorker.id}/test`)
        .expect(200);
      expect(tested.body.ok).toBe(false);

      await request(workerApp).delete(`/api/crew/remote-workers/${created.body.remoteWorker.id}`).expect(200);
      const afterDelete = await request(workerApp).get("/api/crew/remote-workers").expect(200);
      expect(afterDelete.body.remoteWorkers).toHaveLength(0);
    } finally {
      workerDb.close();
    }
  });

  it("rejects a remote worker missing required fields with 400", async () => {
    const res = await request(app).post("/api/crew/remote-workers").send({ label: "x" }).expect(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("rejects a duplicate label with 400", async () => {
    await request(app)
      .post("/api/crew/remote-workers")
      .send({ label: "dup", host: "100.1.1.1", sshUser: "u", privateKeyPath: "/k" })
      .expect(201);
    const res = await request(app)
      .post("/api/crew/remote-workers")
      .send({ label: "dup", host: "100.1.1.2", sshUser: "u", privateKeyPath: "/k" })
      .expect(400);
    expect(res.body.error).toBe("invalid_remote_worker_mutation");
  });

  it("404s testing or deleting a remote worker that doesn't exist", async () => {
    await request(app).post("/api/crew/remote-workers/worker_nope/test").expect(404);
    await request(app).delete("/api/crew/remote-workers/worker_nope").expect(404);
  });
});

describe("meetings over HTTP", () => {
  function twoAgents(): [string, string] {
    const agents = orchestrator.listAgents(companyId);
    return [agents[0].id, agents[1].id];
  }

  it("creates, starts, runs a turn, and ends a meeting", async () => {
    const [moderatorAgentId, participantAgentId] = twoAgents();
    const created = await request(app)
      .post("/api/crew/meetings")
      .send({ topic: "Sprint-Planung", moderatorAgentId, participantAgentIds: [participantAgentId], maxRounds: 3 })
      .expect(201);
    expect(created.body.meeting.status).toBe("scheduled");
    expect(created.body.meeting.max_rounds).toBe(3);
    expect(broadcasts.some((b) => b.type === "crew_meeting_changed")).toBe(true);

    const meetingId = created.body.meeting.id;

    const listed = await request(app).get("/api/crew/meetings").expect(200);
    expect(listed.body.meetings.some((m: { id: string }) => m.id === meetingId)).toBe(true);

    const started = await request(app).post(`/api/crew/meetings/${meetingId}/start`).expect(200);
    expect(started.body.meeting.status).toBe("in_progress");

    const turn = await request(app).post(`/api/crew/meetings/${meetingId}/next-turn`).send({}).expect(200);
    expect(turn.body.turn).not.toBeNull();
    expect(turn.body.meeting.current_round).toBe(1);

    const detail = await request(app).get(`/api/crew/meetings/${meetingId}`).expect(200);
    expect(detail.body.participants).toHaveLength(2);
    expect(detail.body.turns).toHaveLength(1);

    const ended = await request(app)
      .post(`/api/crew/meetings/${meetingId}/end`)
      .send({ minutes: "Ergebnis: weiter wie geplant." })
      .expect(200);
    expect(ended.body.meeting.status).toBe("completed");
    expect(ended.body.meeting.minutes).toBe("Ergebnis: weiter wie geplant.");
  });

  it("lets the moderator pick an explicit speaker for the next turn", async () => {
    const [moderatorAgentId, participantAgentId] = twoAgents();
    const created = await request(app)
      .post("/api/crew/meetings")
      .send({ topic: "x", moderatorAgentId, participantAgentIds: [participantAgentId] })
      .expect(201);
    await request(app).post(`/api/crew/meetings/${created.body.meeting.id}/start`).expect(200);

    const turn = await request(app)
      .post(`/api/crew/meetings/${created.body.meeting.id}/next-turn`)
      .send({ agentId: participantAgentId })
      .expect(200);
    expect(turn.body.turn.agent_id).toBe(participantAgentId);
  });

  it("self-closes at max_rounds — a next-turn call after that returns a null turn, not an error", async () => {
    const [moderatorAgentId, participantAgentId] = twoAgents();
    const created = await request(app)
      .post("/api/crew/meetings")
      .send({ topic: "x", moderatorAgentId, participantAgentIds: [participantAgentId], maxRounds: 1 })
      .expect(201);
    const meetingId = created.body.meeting.id;
    await request(app).post(`/api/crew/meetings/${meetingId}/start`).expect(200);

    const first = await request(app).post(`/api/crew/meetings/${meetingId}/next-turn`).send({}).expect(200);
    expect(first.body.meeting.status).toBe("completed");

    const second = await request(app).post(`/api/crew/meetings/${meetingId}/next-turn`).send({}).expect(200);
    expect(second.body.turn).toBeNull();
  });

  it("cancels a meeting", async () => {
    const [moderatorAgentId, participantAgentId] = twoAgents();
    const created = await request(app)
      .post("/api/crew/meetings")
      .send({ topic: "x", moderatorAgentId, participantAgentIds: [participantAgentId] })
      .expect(201);
    const cancelled = await request(app).post(`/api/crew/meetings/${created.body.meeting.id}/cancel`).expect(200);
    expect(cancelled.body.meeting.status).toBe("cancelled");
  });

  it("rejects a meeting missing required fields with 400", async () => {
    const res = await request(app).post("/api/crew/meetings").send({ topic: "x" }).expect(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("404s a meeting that doesn't exist", async () => {
    await request(app).get("/api/crew/meetings/mtg_nope").expect(404);
    await request(app).post("/api/crew/meetings/mtg_nope/start").expect(404);
    await request(app).post("/api/crew/meetings/mtg_nope/next-turn").send({}).expect(404);
    await request(app).post("/api/crew/meetings/mtg_nope/cancel").expect(404);
  });

  it("adds an action item and converts it into a real, visible task", async () => {
    const [moderatorAgentId, participantAgentId] = twoAgents();
    const created = await request(app)
      .post("/api/crew/meetings")
      .send({ topic: "x", moderatorAgentId, participantAgentIds: [participantAgentId] })
      .expect(201);
    const meetingId = created.body.meeting.id;

    const item = await request(app)
      .post(`/api/crew/meetings/${meetingId}/action-items`)
      .send({ description: "Angebot nachfassen", assignedAgentId: participantAgentId })
      .expect(201);
    expect(item.body.actionItem.description).toBe("Angebot nachfassen");
    expect(item.body.actionItem.task_id).toBeNull();

    const converted = await request(app)
      .post(`/api/crew/meetings/action-items/${item.body.actionItem.id}/convert`)
      .expect(201);
    expect(converted.body.task.assigned_agent_id).toBe(participantAgentId);
    expect(broadcasts.some((b) => b.type === "crew_task_changed")).toBe(true);

    const detail = await request(app).get(`/api/crew/meetings/${meetingId}`).expect(200);
    expect(detail.body.actionItems[0].task_id).toBe(converted.body.task.id);
  });

  it("404s converting an action item that doesn't exist", async () => {
    await request(app).post("/api/crew/meetings/action-items/action_nope/convert").expect(404);
  });
});

describe("memory over HTTP (Obsidian vault, the first MemoryProvider)", () => {
  function fakeMemoryProvider() {
    return {
      kind: "obsidian",
      write: async (entry: { kind: string; title: string; content: string }) => ({
        externalId: `${entry.kind}/mem_fake`,
        path: `IronCrew/${entry.kind}/mem_fake.md`,
      }),
      read: async () => '---\ntitle: "x"\n---\n\nNightly backups run at 02:00 UTC.',
      delete: async () => {},
      search: async (query: string) =>
        query.toLowerCase().includes("nightly")
          ? [
              {
                externalId: "note/mem_fake",
                title: "Backup policy",
                snippet: "…nightly…",
                path: "IronCrew/note/mem_fake.md",
              },
            ]
          : [],
      testConnection: async () => ({ ok: true, message: "Vault erreichbar." }),
    };
  }

  it("lists providers with their registration + connection status", async () => {
    orchestrator.registerMemoryProvider(fakeMemoryProvider() as never);
    const res = await request(app).get("/api/crew/memory-providers").expect(200);
    expect(res.body.providers).toEqual([
      { kind: "obsidian", registered: true, ok: true, message: "Vault erreichbar." },
    ]);
  });

  it("records a memory entry through its provider and lists it", async () => {
    orchestrator.registerMemoryProvider(fakeMemoryProvider() as never);
    const created = await request(app)
      .post("/api/crew/memory")
      .send({
        provider: "obsidian",
        kind: "note",
        title: "Backup policy",
        content: "Nightly backups run at 02:00 UTC.",
      })
      .expect(201);
    expect(created.body.memory.provider).toBe("obsidian");
    expect(created.body.memory.external_id).toBe("note/mem_fake");
    expect(broadcasts.some((b) => b.type === "crew_memory_changed")).toBe(true);

    const list = await request(app).get("/api/crew/memory").expect(200);
    expect(list.body.memories).toHaveLength(1);
    expect(list.body.memories[0].title).toBe("Backup policy");
  });

  it("reads a memory entry's live content back through its provider", async () => {
    orchestrator.registerMemoryProvider(fakeMemoryProvider() as never);
    const created = await request(app)
      .post("/api/crew/memory")
      .send({ provider: "obsidian", kind: "note", title: "x", content: "y" })
      .expect(201);

    const res = await request(app).get(`/api/crew/memory/${created.body.memory.id}`).expect(200);
    expect(res.body.content).toContain("Nightly backups");
  });

  it("deletes a memory entry", async () => {
    orchestrator.registerMemoryProvider(fakeMemoryProvider() as never);
    const created = await request(app)
      .post("/api/crew/memory")
      .send({ provider: "obsidian", kind: "note", title: "x", content: "y" })
      .expect(201);

    await request(app).delete(`/api/crew/memory/${created.body.memory.id}`).expect(200);
    const list = await request(app).get("/api/crew/memory").expect(200);
    expect(list.body.memories).toHaveLength(0);
  });

  it("searches a provider's content", async () => {
    orchestrator.registerMemoryProvider(fakeMemoryProvider() as never);
    const res = await request(app).get("/api/crew/memory/search?provider=obsidian&q=nightly").expect(200);
    expect(res.body.hits).toHaveLength(1);
    expect(res.body.hits[0].title).toBe("Backup policy");
  });

  it("rejects recording without a required field with 400", async () => {
    orchestrator.registerMemoryProvider(fakeMemoryProvider() as never);
    const res = await request(app).post("/api/crew/memory").send({ provider: "obsidian", kind: "note" }).expect(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("404s reading or deleting a memory entry that doesn't exist", async () => {
    await request(app).get("/api/crew/memory/mem_nope").expect(404);
    await request(app).delete("/api/crew/memory/mem_nope").expect(404);
  });

  it("400s search without provider or q", async () => {
    await request(app).get("/api/crew/memory/search?provider=obsidian").expect(400);
    await request(app).get("/api/crew/memory/search?q=nightly").expect(400);
  });
});
