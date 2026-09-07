import { it, expect } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Repository } from "../../packages/persistence/src/index.ts";
import { IncidentWorkflow } from "../../packages/domain/workflows/incident.ts";
import { ManagedActions } from "../../packages/domain/workflows/actions.ts";
it("restores an actually stopped child HTTP service, independently observes it and detects a real recurrence", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "incident-process-")),
    repo = await Repository.open(path.join(directory, "company.sqlite"));
  let child: ChildProcess | undefined,
    port = 0;
  const start = async () => {
    child = spawn(
      process.execPath,
      [
        "-e",
        "const {createServer}=require('node:http');const s=createServer((q,r)=>{r.writeHead(200,{'Content-Type':'application/json'});r.end(JSON.stringify({ready:true,pid:process.pid}));});s.listen(Number(process.env.PORT),'127.0.0.1',()=>process.send({port:s.address().port}));",
      ],
      { env: { PORT: String(port) }, stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    const [ready] = await Promise.race([
      once(child, "message"),
      once(child, "exit").then(() => {
        throw new Error("Service startup failed");
      }),
    ]);
    port = (ready as { port: number }).port;
  };
  const stop = async () => {
    if (child && child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
    child = undefined;
  };
  const probe = async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) }),
        body = (await response.json()) as { ready: boolean; pid: number };
      return {
        ok: response.ok && body.ready,
        evidence: JSON.stringify({ url: `http://127.0.0.1:${port}/health`, status: response.status, body }),
      };
    } catch {
      return { ok: false, evidence: "Connection to the explicit local fixture service failed" };
    }
  };
  try {
    const setup = await repo.setup({
        companyName: "Incident process fixture",
        ceoName: "CEO",
        passwordHash: "fixture",
        timezone: "UTC",
        budgetLimitUsdMicros: "0",
      }),
      scope = { companyId: setup.company.id, areaId: setup.areas[0]!.id },
      targetId = randomUUID();
    await start();
    expect((await probe()).ok).toBe(true);
    await stop();
    expect((await probe()).ok).toBe(false);
    const incident = new IncidentWorkflow(repo),
      record = await incident.ingest(scope, {
        provider: "local-child-fixture",
        accountId: "loopback",
        eventId: "service-stop",
        targetId,
        summary: "Fixture service is unreachable",
        budgetLimitUsdMicros: "0",
      });
    await incident.diagnose(scope, record.id, {
      evidence: "The owned child process exited after SIGTERM and independent HTTP refused connection",
      causeStatus: "confirmed",
      explanation: "Explicitly stopped fixture process",
    });
    const mandate = {
      id: randomUUID(),
      version: 1,
      scope,
      allowedToolIds: ["fixture.service.restart"],
      targetIds: [targetId],
      parameterConstraints: {},
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      maxAttempts: 2,
      maxDurationSeconds: 30,
      maxCostUsdMicros: "0",
    };
    await repo.createMandate(mandate);
    const actions = new ManagedActions(repo, path.join(directory, "receipts")),
      request = {
        id: randomUUID(),
        toolId: "fixture.service.restart",
        effect: "external_change" as const,
        mandateId: mandate.id,
        mandateVersion: 1,
        args: { service: "owned-local-http-fixture" },
      };
    let restarts = 0;
    const repaired = await incident.repair(scope, record.id, actions, request, async () => {
      await start();
      restarts++;
      return { started: true, pid: child!.pid };
    });
    expect(repaired.state).toBe("succeeded");
    await incident.repair(scope, record.id, actions, request, async () => {
      restarts++;
      throw new Error("Must not replay");
    });
    expect(restarts).toBe(1);
    expect((await incident.check(scope, record.id, 1, probe)).data.state).toBe("observing");
    await new Promise((resolve) => setTimeout(resolve, 1050));
    expect((await incident.check(scope, record.id, 1, probe)).data.state).toBe("resolved");
    await stop();
    const recurrence = await incident.check(scope, record.id, 1, probe);
    expect(recurrence.data.state).toBe("investigating");
    expect(recurrence.data.cause.status).toBe("confirmed");
    const prevention = await incident.prevention(scope, record.id, "Prevent unexpected fixture process exits", "0");
    expect(prevention.status).toBe("inbox");
  } finally {
    await stop();
    await repo.close();
    await rm(directory, { recursive: true, force: true });
  }
});
