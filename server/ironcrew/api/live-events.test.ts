import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../domain/test-db.ts";
import { createCrewAuth, type CrewAuth } from "../auth/crew-auth.ts";
import { CrewLiveEvents } from "./live-events.ts";

class ResponseDouble extends EventEmitter {
  writableLength = 0;
  set = vi.fn();
  flushHeaders = vi.fn();
  write = vi.fn();
  end = vi.fn();
  status = vi.fn(() => this);
  json = vi.fn();
}

describe("company live channel", () => {
  let db: ReturnType<typeof createTestDb>;
  let auth: CrewAuth;
  const responses: ResponseDouble[] = [];
  beforeEach(() => {
    db = createTestDb();
    auth = createCrewAuth(db);
  });
  afterEach(() => {
    for (const res of responses.splice(0)) res.emit("close");
    db.close();
  });

  function connect(hub: CrewLiveEvents, token?: string) {
    const res = new ResponseDouble();
    responses.push(res);
    const req = { header: (name: string) => (name === "cookie" && token ? `ironcrew_session=${token}` : undefined) };
    hub.connect(req as Request, res as unknown as Response, auth);
    return res;
  }

  it("resynchronizes each connection and publishes payload-free mutation notices", () => {
    const hub = new CrewLiveEvents("company-a");
    const res = connect(hub);
    expect(res.write).toHaveBeenCalledWith(expect.stringContaining('"resync":true'));
    hub.publish("crew_task_changed", { privateField: "must not travel" });
    expect(res.write).toHaveBeenLastCalledWith(expect.stringContaining('"type":"crew_task_changed"'));
    expect(res.write.mock.calls.flat().join()).not.toContain("must not travel");
    res.emit("close");
    const next = connect(hub);
    expect(next.write).toHaveBeenCalledWith(expect.stringContaining('"resync":true'));
  });

  it("refuses malformed and other-company run events", () => {
    const hub = new CrewLiveEvents("company-a");
    const res = connect(hub);
    res.write.mockClear();
    hub.publish("crew_run_event", { companyId: "company-b" });
    hub.publish("task_update", {});
    hub.publish("crew_run_event", {
      eventId: "event-a",
      companyId: "company-b",
      taskId: "task-a",
      runId: "run-a",
      seq: 1,
      type: "run.started",
      timestamp: Date.now(),
      correlationId: "test",
      payload: {},
      redaction: { redacted: false, rules: [] },
    });
    expect(res.write).not.toHaveBeenCalled();
    hub.publish("crew_run_event", {
      eventId: "event-a",
      companyId: "company-a",
      taskId: "task-a",
      runId: "run-a",
      seq: 1,
      type: "run.started",
      timestamp: Date.now(),
      correlationId: "test",
      payload: {},
      redaction: { redacted: false, rules: [] },
    });
    expect(res.write).toHaveBeenCalledOnce();
  });

  it("requires a crew session once identity is enabled", async () => {
    await auth.users.create({ email: "owner@example.com", password: "correct horse staple" });
    const res = connect(new CrewLiveEvents("company-a"));
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.flushHeaders).not.toHaveBeenCalled();
  });

  it("cuts off an existing connection immediately after session revocation", async () => {
    const user = await auth.users.create({ email: "owner@example.com", password: "correct horse staple" });
    const { token } = auth.sessions.create(user.id);
    const hub = new CrewLiveEvents("company-a");
    const res = connect(hub, token);
    expect(res.write).toHaveBeenCalledOnce();
    auth.sessions.revoke(token);
    hub.publish("crew_task_changed", {});
    expect(res.end).toHaveBeenCalledOnce();
    expect(res.write).toHaveBeenCalledOnce();
    hub.publish("crew_task_changed", {});
    expect(res.end).toHaveBeenCalledOnce();
  });

  it("closes anonymous bootstrap streams when the first account is created", async () => {
    const hub = new CrewLiveEvents("company-a");
    const res = connect(hub);
    await auth.users.create({ email: "owner@example.com", password: "correct horse staple" });
    hub.publish("crew_task_changed", {});
    expect(res.end).toHaveBeenCalledOnce();
    expect(res.write).toHaveBeenCalledOnce();
  });

  it("bounds slow-client buffering and removes disconnected listeners", () => {
    const hub = new CrewLiveEvents("company-a");
    const slow = connect(hub);
    slow.writableLength = 300 * 1024;
    hub.publish("crew_task_changed", {});
    expect(slow.end).toHaveBeenCalledOnce();
    expect(slow.write).toHaveBeenCalledOnce();
    const gone = connect(hub);
    gone.emit("close");
    hub.publish("crew_task_changed", {});
    expect(gone.write).toHaveBeenCalledOnce();
  });
});
