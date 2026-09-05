import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { WebSocketServer, WebSocket } from "ws";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { createTestDb, seedCompany } from "../../domain/test-db.ts";
import { FleetHub } from "./hub.ts";
import { RunStore } from "../../runtime/run-store.ts";
import { FleetStore } from "./store.ts";
import { OutboundRunner } from "./outbound.ts";
import { MockRuntime } from "../../runtime/mock-runtime.ts";
import type { RunContext, RunEvent } from "../../runtime/run-events.ts";

let dir: string, cert: Buffer, key: Buffer;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-test-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=IronCrew Fleet Test",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-keyout",
      path.join(dir, "server.key"),
      "-out",
      path.join(dir, "server.crt"),
    ],
    { stdio: "pipe" },
  );
  cert = fs.readFileSync(path.join(dir, "server.crt"));
  key = fs.readFileSync(path.join(dir, "server.key"));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
const input = {
  label: "native",
  workspaceRoot: "/tmp/fleet-projects",
  runtimeTypes: ["mock" as const],
  allowUnscoped: true,
};
const context = (companyId: string): RunContext => ({
  companyId,
  projectId: null,
  taskId: "task",
  runId: "run",
  agentId: null,
  correlationId: "correlation",
  workspacePath: "",
  permissionMode: "restricted",
});

async function setup(runtime = new MockRuntime()) {
  const db = createTestDb(),
    companyId = seedCompany(db);
  const hub = new FleetHub({ db, companyId });
  const server = https.createServer({ key, cert, minVersion: "TLSv1.3" });
  const wss = new WebSocketServer({ server, maxPayload: 1_100_000 });
  wss.on("connection", (ws, req) => hub.handleConnection(ws, req));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing listener");
  const url = `wss://127.0.0.1:${address.port}/api/crew/fleet/connect`;
  const runners: OutboundRunner[] = [];
  const add = async (label = "native", credentialDirectory = dir) => {
    const { worker, enrollment } = hub.store.create({ ...input, label, workspaceRoot: dir }, "owner");
    const credentialFile = path.join(credentialDirectory, `${worker.id}.json`);
    const runner = new OutboundRunner({
      url,
      credentialFile,
      enrollmentToken: enrollment.token,
      workspaceRoot: dir,
      runtimes: [runtime],
      ca: cert,
    });
    runners.push(runner);
    await runner.start();
    return { runner, worker, enrollment, credentialFile };
  };
  const close = async () => {
    for (const runner of runners) await runner.close();
    hub.close();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  };
  return { db, companyId, hub, url, add, close, runners };
}

describe("persistent fleet scopes and leases", () => {
  it("consumes enrollment once, stores hashes, rotates with bounded grace, and revokes persistently", () => {
    const db = createTestDb(),
      companyId = seedCompany(db);
    let now = Date.now();
    const store = new FleetStore(db, companyId, () => now);
    try {
      const created = store.create(input, "owner");
      const enrolled = store.enroll(created.enrollment.token)!;
      expect(enrolled).not.toBeNull();
      expect(store.enroll(created.enrollment.token)).toBeNull();
      expect(store.authenticate(enrolled.credential)?.id).toBe(created.worker.id);
      const serialized = JSON.stringify(db.prepare("SELECT * FROM crew_fleet_workers").all());
      expect(serialized).not.toContain(enrolled.credential);
      expect(serialized).not.toContain(created.enrollment.token);
      const rotation = store.rotate(created.worker.id, true)!;
      expect(store.authenticate(enrolled.credential)).not.toBeNull();
      now += 120_001;
      expect(store.authenticate(enrolled.credential)).toBeNull();
      expect(store.authenticate(rotation.credential)).not.toBeNull();
      store.revoke(created.worker.id, "owner");
      expect(new FleetStore(db, companyId, () => now).authenticate(rotation.credential)).toBeNull();
    } finally {
      db.close();
    }
  });
  it("rejects expired enrollment and foreign company credentials", () => {
    const db = createTestDb(),
      companyId = seedCompany(db);
    let now = Date.now();
    const store = new FleetStore(db, companyId, () => now);
    try {
      const created = store.create({ ...input, ttlSeconds: 30 }, "owner");
      now += 30_001;
      expect(store.enroll(created.enrollment.token)).toBeNull();
      const active = store.create(input, "owner");
      const enrolled = store.enroll(active.enrollment.token)!;
      expect(new FleetStore(db, seedCompany(db)).authenticate(enrolled.credential)).toBeNull();
      now += 31 * 86400_000;
      expect(store.authenticate(enrolled.credential)).toBeNull();
    } finally {
      db.close();
    }
  });
});

it("drains disconnected leases through the deadline and recovers registry state on restart", async () => {
  const db = createTestDb(),
    companyId = seedCompany(db);
  let now = Date.now();
  const store = new FleetStore(db, companyId, () => now);
  try {
    const created = store.create(input, "owner");
    store.enroll(created.enrollment.token);
    const worker = store.connect(created.worker.id);
    const mock = new MockRuntime();
    const descriptor = {
      type: "mock",
      capabilities: await mock.capabilities(),
      health: await mock.healthCheck(),
      auth: await mock.authStatus(),
    };
    store.heartbeat(worker.id, worker.generation, [descriptor]);
    store.reserve("mock", context(companyId), new Set([worker.id]));
    store.recover();
    expect(store.get(worker.id)?.state).toBe("offline");
    expect(store.leases()[0].state).toBe("lost");
    const next = store.connect(worker.id);
    store.heartbeat(worker.id, next.generation, [descriptor]);
    expect(() => store.reserve("mock", context(companyId), new Set([worker.id]))).toThrow("still draining");
    now += 60_001;
    store.heartbeat(worker.id, next.generation, [descriptor]);
    expect(store.reserve("mock", context(companyId), new Set([worker.id])).lease.generation).toBe(next.generation);
  } finally {
    db.close();
  }
});

describe("real outgoing WSS runner", () => {
  it("enrolls, saves private credentials, executes streaming v2 with usage ACK and records selected lease", async () => {
    const fixture = await setup();
    try {
      const { worker, credentialFile } = await fixture.add();
      expect(fs.statSync(credentialFile).mode & 0o777).toBe(0o600);
      expect(fixture.hub.store.get(worker.id)?.state).toBe("online");
      const events: RunEvent[] = [];
      for await (const event of fixture.hub.runtime("mock").startRun({ prompt: "Task" }, context(fixture.companyId)))
        events.push(event);
      expect(events.map((e) => e.type)).toContain("usage.updated");
      expect(events.at(-1)?.type).toBe("run.completed");
      expect(fixture.hub.store.leases()).toEqual([
        expect.objectContaining({ worker_id: worker.id, state: "completed" }),
      ]);
    } finally {
      await fixture.close();
    }
  });
  it("enrolls through a canonicalized system-style directory alias without accepting a credential-file symlink", async () => {
    const fixture = await setup();
    try {
      const canonical = fs.mkdtempSync(path.join(dir, "credential-owned-"));
      const alias = `${canonical}-alias`;
      fs.symlinkSync(canonical, alias, "dir");
      const enrolled = await fixture.add("aliased", alias);
      expect(fs.realpathSync(enrolled.credentialFile)).toBe(
        path.join(fs.realpathSync(canonical), path.basename(enrolled.credentialFile)),
      );
      expect(fs.statSync(enrolled.credentialFile).mode & 0o777).toBe(0o600);
      const link = path.join(canonical, "linked-credential.json");
      fs.symlinkSync(enrolled.credentialFile, link);
      const rejected = new OutboundRunner({
        url: fixture.url,
        credentialFile: link,
        workspaceRoot: dir,
        runtimes: [new MockRuntime()],
        ca: cert,
      });
      await expect(rejected.start()).rejects.toThrow();
    } finally {
      await fixture.close();
    }
  });
  it("uses deterministic capacity routing and rejects duplicate active task claims or foreign scopes", async () => {
    const fixture = await setup();
    try {
      const a = await fixture.add("A"),
        b = await fixture.add("B");
      const expected = [a.worker.id, b.worker.id].sort()[0];
      const reserved = fixture.hub.reserve("mock", context(fixture.companyId));
      expect(reserved.lease.worker_id).toBe(expected);
      expect(() => fixture.hub.reserve("mock", context(fixture.companyId))).toThrow();
      const second = fixture.hub.reserve("mock", {
        ...context(fixture.companyId),
        taskId: "second",
        runId: "second-run",
      });
      expect(second.lease.worker_id).not.toBe(expected);
      expect(() => fixture.hub.reserve("mock", { ...context(fixture.companyId), taskId: "third" })).toThrow();
      fixture.hub.store.release(reserved.lease.id);
      expect(() => fixture.hub.reserve("mock", { ...context("foreign"), taskId: "foreign" })).toThrow();
      expect(() =>
        fixture.hub.reserve("mock", { ...context(fixture.companyId), projectId: "ungranted", taskId: "ungranted" }),
      ).toThrow();
    } finally {
      await fixture.close();
    }
  });
  it("reports unavailable capacity as persisted waiting without fabricating a provider rate limit", async () => {
    const fixture = await setup();
    try {
      const events: RunEvent[] = [];
      for await (const event of fixture.hub.runtime("mock").startRun({ prompt: "wait" }, context(fixture.companyId)))
        events.push(event);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "run.waiting", payload: { reason: "runner_unavailable" } });
      expect(events[0].payload.retryAt).toBeGreaterThan(Date.now());
    } finally {
      await fixture.close();
    }
  });
  it("pins persisted session continuation to the original worker rather than the highest-priority alternative", async () => {
    const fixture = await setup();
    try {
      await fixture.add("A");
      await fixture.add("B");
      fixture.db
        .prepare("INSERT INTO crew_tasks(id,company_id,title) VALUES('session-task',?,'Session task')")
        .run(fixture.companyId);
      const runs = new RunStore(fixture.db);
      const previous = runs.create({ companyId: fixture.companyId, taskId: "session-task", runtimeType: "mock" });
      const ctx = { ...context(fixture.companyId), taskId: "session-task", runId: previous.id };
      for await (const _event of fixture.hub.runtime("mock").startRun({ prompt: "start" }, ctx)) {
        /* consume through usage ACK */
      }
      const owner = runs.get(previous.id)!.worker_id;
      expect(owner).toBeTruthy();
      fixture.db
        .prepare("UPDATE crew_runs SET session_ref='saved-session',workspace_path='' WHERE id=?")
        .run(previous.id);
      fixture.db.prepare("UPDATE crew_fleet_workers SET priority=100 WHERE id<>?").run(owner);
      const resumed = fixture.hub.reserve("mock", { ...ctx, runId: "resumed" }, "saved-session");
      expect(resumed.lease.worker_id).toBe(owner);
      fixture.hub.store.release(resumed.lease.id);
      fixture.hub.revoke(owner!, "owner");
      expect(() => fixture.hub.reserve("mock", { ...ctx, runId: "retry" }, "saved-session")).toThrow("No healthy");
    } finally {
      await fixture.close();
    }
  });
  it("does not acknowledge rejected usage or execute the next model round", async () => {
    let nextRound = false;
    class BudgetRuntime extends MockRuntime {
      async *startRun(_input: { prompt: string }, ctx: RunContext): AsyncIterable<RunEvent> {
        for (const type of ["run.started", "usage.updated", "run.completed"] as const) {
          if (type === "run.completed") nextRound = true;
          yield {
            eventId: type,
            companyId: ctx.companyId,
            projectId: null,
            taskId: ctx.taskId,
            runId: ctx.runId,
            agentId: null,
            seq: type === "run.started" ? 0 : type === "usage.updated" ? 1 : 2,
            type,
            timestamp: Date.now(),
            correlationId: ctx.correlationId,
            payload: {},
            redaction: { redacted: false, rules: [] },
          };
        }
      }
    }
    const fixture = await setup(new BudgetRuntime());
    try {
      await fixture.add();
      const abort = new AbortController();
      const events: RunEvent[] = [];
      for await (const event of fixture.hub
        .runtime("mock")
        .startRun({ prompt: "budget" }, { ...context(fixture.companyId), signal: abort.signal })) {
        events.push(event);
        if (event.type === "usage.updated") abort.abort();
      }
      expect(nextRound).toBe(false);
      expect(events.at(-1)?.type).toBe("run.cancelled");
      expect(fixture.hub.store.leases()[0].state).toBe("lost");
    } finally {
      await fixture.close();
    }
  });
  it("revokes a live runner, loses leases and refuses its saved credential", async () => {
    const fixture = await setup();
    try {
      const { worker, credentialFile } = await fixture.add();
      fixture.hub.reserve("mock", context(fixture.companyId));
      fixture.hub.revoke(worker.id, "owner");
      expect(fixture.hub.store.leases()[0].state).toBe("revoked");
      expect(fixture.hub.store.get(worker.id)?.state).toBe("revoked");
      expect(fixture.hub.store.authenticate(JSON.parse(fs.readFileSync(credentialFile, "utf8")).credential)).toBeNull();
      expect((await fixture.hub.runtime("mock").healthCheck()).healthy).toBe(false);
    } finally {
      await fixture.close();
    }
  });
  it("reconnects from disk, fences the previous connection and never replays its lease", async () => {
    const fixture = await setup();
    try {
      const first = await fixture.add();
      fixture.hub.reserve("mock", context(fixture.companyId));
      const generation = fixture.hub.store.get(first.worker.id)!.generation;
      const second = new OutboundRunner({
        url: fixture.url,
        credentialFile: first.credentialFile,
        workspaceRoot: dir,
        runtimes: [new MockRuntime()],
        ca: cert,
      });
      fixture.runners.push(second);
      await second.start();
      await first.runner.close();
      expect(fixture.hub.store.get(first.worker.id)?.generation).toBe(generation + 1);
      expect(fixture.hub.store.leases()[0].state).toBe("lost");
      expect(() => fixture.hub.reserve("mock", context(fixture.companyId))).toThrow("still draining");
      const events: RunEvent[] = [];
      for await (const event of fixture.hub
        .runtime("mock")
        .startRun({ prompt: "retry" }, { ...context(fixture.companyId), taskId: "next-task", runId: "retry" }))
        events.push(event);
      expect(events.at(-1)).toMatchObject({ type: "run.waiting", payload: { reason: "runner_unavailable" } });
    } finally {
      await fixture.close();
    }
  });
  it("rejects bearer credentials in URL, insecure endpoints and untrusted TLS certificates", async () => {
    expect(
      () =>
        new OutboundRunner({
          url: "ws://example.com/api/crew/fleet/connect",
          credentialFile: "/tmp/credential",
          workspaceRoot: dir,
          runtimes: [],
        }),
    ).toThrow("WSS");
    const fixture = await setup();
    try {
      const enrollment = fixture.hub.store.create({ ...input, workspaceRoot: dir }, "owner");
      const runner = new OutboundRunner({
        url: fixture.url,
        credentialFile: path.join(dir, "untrusted.json"),
        enrollmentToken: enrollment.enrollment.token,
        workspaceRoot: dir,
        runtimes: [new MockRuntime()],
      });
      await expect(runner.start()).rejects.toThrow("Fleet connection failed");
      expect(fixture.hub.store.get(enrollment.worker.id)?.state).toBe("offline");
      const ws = new WebSocket(`${fixture.url}?token=${enrollment.enrollment.token}`, { ca: cert });
      const [code] = await once(ws, "close");
      expect(code).toBe(1008);
    } finally {
      await fixture.close();
    }
  });
});
