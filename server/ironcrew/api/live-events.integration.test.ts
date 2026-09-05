import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../domain/test-db.ts";
import { CompanyOrchestrator } from "../orchestrator/company.ts";
import { MockRuntime } from "../runtime/mock-runtime.ts";
import { buildCrewJobs } from "../scheduler/crew-jobs.ts";
import { registerIronCrewRoutes } from "./routes.ts";
import { CrewLiveEvents } from "./live-events.ts";

afterEach(() => vi.restoreAllMocks());

describe("live channel wiring", () => {
  it("guards the stream with crew identity, not merely a shared legacy credential", async () => {
    const db = createTestDb();
    try {
      const app = express();
      const api = registerIronCrewRoutes(app, { db });
      await api.auth.users.create({ email: "owner@example.com", password: "correct horse staple" });
      const connect = vi.spyOn(CrewLiveEvents.prototype, "connect");
      await request(app).get("/api/crew/events").expect(401);
      expect(connect).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it("uses the same live channel for REST writes and background execution", async () => {
    const db = createTestDb();
    try {
      const app = express();
      app.use(express.json());
      const orchestrator = new CompanyOrchestrator(db);
      orchestrator.registerRuntime(new MockRuntime({ responseText: "Bericht erstellt." }));
      const api = registerIronCrewRoutes(app, { db, orchestrator });
      // Subscribe to the real hub at its boundary, keeping the test free of
      // an infinite HTTP response. All work still goes through real stores.
      const publish = vi.spyOn(CrewLiveEvents.prototype, "publish");
      await request(app).post("/api/crew/goals").send({ title: "Betrieb dokumentieren" }).expect(201);
      expect(publish.mock.calls.map(([type]) => type)).toContain("crew_state_changed");
      publish.mockClear();
      const task = orchestrator.handleCeoMessage(api.companyId, "Bitte dokumentiere das Deployment-Verfahren.").task!;
      const jobs = buildCrewJobs({ orchestrator, companyId: api.companyId, broadcast: api.broadcast });
      await jobs.find((job) => job.name === "run-queue")!.run();
      expect(orchestrator.tasks.get(task.id)?.status).toBe("review");
      expect(publish.mock.calls.map(([type]) => type)).toContain("crew_task_changed");
      const events = publish.mock.calls.filter(([type]) => type === "crew_run_event").map(([, event]) => event);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ companyId: api.companyId, taskId: task.id, type: "run.started" }),
          expect.objectContaining({ companyId: api.companyId, taskId: task.id, type: "run.completed" }),
        ]),
      );
    } finally {
      db.close();
    }
  });
});
