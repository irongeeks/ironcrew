import { createFixtureLauncher } from "../fixtures/launcher.ts";
import { beforeEach, afterEach, it, expect } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { Repository, type SetupResult } from "../../packages/persistence/src/index.ts";
import { IncidentWorkflow } from "../../packages/domain/workflows/incident.ts";
import { IncidentService, type HealthProfile } from "../../apps/control/incident-service.ts";
import { incidentRuntimeTools } from "../../apps/control/incident-tools.ts";
import { configSchema, type Configuration } from "../../apps/control/configuration.ts";
import { sha256 } from "../../packages/domain/src/index.ts";
import type { Scope, ToolAction, ApprovalBinding } from "../../packages/contracts/src/index.ts";
let repo: Repository,
  directory: string,
  setup: SetupResult,
  scope: Scope,
  config: Configuration,
  service: IncidentService,
  server: Server,
  now: Date,
  profile: HealthProfile,
  reads: number,
  probeAdvanceMs: number;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "ironcrew-incident-control-"));
  now = new Date();
  reads = 0;
  probeAdvanceMs = 0;
  const healthState = path.join(directory, "health-state.txt");
  await writeFile(healthState, "down");
  const executable = await createFixtureLauncher(
    directory,
    "fixture-systemctl",
    `import {writeFile,appendFile} from 'node:fs/promises';\nif(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['restart','--','fixture.service']))process.exit(42);\nawait writeFile(${JSON.stringify(healthState)},'healthy');await appendFile(${JSON.stringify(path.join(directory, "broker-calls.txt"))},'restart\\n');\n`,
  );
  server = createServer(async (_req, res) => {
    reads++;
    now = new Date(now.getTime() + probeAdvanceMs);
    const value = await readFile(healthState, "utf8");
    res.writeHead(value === "healthy" ? 200 : 503, { "content-type": "text/plain" });
    res.end(value === "healthy" ? "independent fixture ready" : value);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  repo = await Repository.open(path.join(directory, "company.sqlite"));
  setup = await repo.setup({
    companyName: "Incident fixture",
    ceoName: "CEO",
    passwordHash: "fixture",
    timezone: "UTC",
    budgetLimitUsdMicros: "0",
  });
  scope = { companyId: setup.company.id, areaId: setup.areas[0]!.id };
  config = configSchema.parse({
    liveExecutionEnabled: true,
    serviceTargets: [{ id: randomUUID(), scope, kind: "systemd", resourceName: "fixture.service", executable }],
  });
  service = new IncidentService({
    repo,
    directory,
    configuration: async () => config,
    now: () => now,
    secrets: { resolve: async () => "fixture-password" },
  });
  profile = (
    await service.configureHealth(scope, setup.ceo.id, {
      targetId: config.serviceTargets[0]!.id,
      scope,
      url: `http://127.0.0.1:${port}/health`,
      contains: ["independent fixture ready"],
      observationSeconds: 6,
      checkIntervalSeconds: 1,
      maxCheckGapSeconds: 2,
    })
  ).data;
});
afterEach(async () => {
  server?.closeAllConnections();
  if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  await repo?.close();
  await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const incident = await new IncidentWorkflow(repo, () => now).ingest(scope, {
    provider: "fixture",
    accountId: "fixture",
    eventId: randomUUID(),
    targetId: profile.targetId,
    summary: "Stopped fixture service",
    budgetLimitUsdMicros: "0",
  });
  const mandate = await repo.createMandate({
    id: randomUUID(),
    version: 1,
    scope,
    allowedToolIds: ["incident.repair", "incident.check", "incident.customer_message", "incident.health_profiles"],
    targetIds: [profile.targetId, ...config.mailConnections.map((c) => c.id)],
    parameterConstraints: {},
    expiresAt: new Date(now.getTime() + 3600000).toISOString(),
    maxAttempts: 2,
    maxDurationSeconds: 120,
    maxCostUsdMicros: "0",
  });
  return {
    id: incident.id,
    actionId: randomUUID(),
    mandateId: mandate.id,
    mandateVersion: 1,
    targetId: profile.targetId,
    targetConfigSha256: sha256(config.serviceTargets[0]),
  };
}
async function approve(id: string) {
  const request = await repo.getDocument<{ binding: ApprovalBinding }>(scope, "approval-request", id),
    approved = await repo.approve(scope, request!.data.binding),
    action = await repo.getDocument<ToolAction>(scope, "action", id);
  await repo.putDocument(
    scope,
    "action",
    id,
    { ...action!.data, approvalId: approved.id, status: "authorized" },
    { expectedRevision: action!.revision },
  );
}
const checkInput = (f: Awaited<ReturnType<typeof fixture>>) => ({
  actionId: randomUUID(),
  mandateId: f.mandateId,
  mandateVersion: 1,
  targetId: profile.targetId,
  healthProfileSha256: profile.fingerprint,
});
const repairInput = (f: Awaited<ReturnType<typeof fixture>>) => ({
  actionId: f.actionId,
  mandateId: f.mandateId,
  mandateVersion: 1,
  targetId: f.targetId,
  targetConfigSha256: f.targetConfigSha256,
});
async function repair(f: Awaited<ReturnType<typeof fixture>>) {
  expect((await service.repair(scope, f.id, repairInput(f))).state).toBe("approval");
  await approve(f.actionId);
  expect((await service.repair(scope, f.id, repairInput(f))).state).toBe("succeeded");
}
it("executes an actual typed child broker, then resolves only after independent HTTP checks across the full observation window", async () => {
  const f = await fixture();
  expect((await service.check(scope, f.id, checkInput(f))).data).toMatchObject({ incidentState: "investigating" });
  await repair(f);
  expect((await service.status(scope, f.id)).incident.state).toBe("repairing");
  expect(await readFile(path.join(directory, "broker-calls.txt"), "utf8")).toBe("restart\n");
  expect((await service.check(scope, f.id, checkInput(f))).data).toMatchObject({ incidentState: "observing" });
  for (let i = 1; i <= 6; i++) {
    now = new Date(now.getTime() + 1000);
    await service.tick(scope);
    expect((await service.status(scope, f.id)).incident.state).toBe(i === 6 ? "resolved" : "observing");
  }
  expect(reads).toBe(8);
  expect((await service.status(scope, f.id)).incident.cause.status).toBe("unknown");
});
it.each(["recurrence", "gap", "revoked", "profile"])(
  "stops observation on %s and never invents a healthy completed window",
  async (fault) => {
    const f = await fixture();
    await repair(f);
    await service.check(scope, f.id, checkInput(f));
    if (fault === "recurrence") await writeFile(path.join(directory, "health-state.txt"), "down");
    if (fault === "revoked") await repo.revokeMandate(scope, f.mandateId, 1);
    if (fault === "profile") {
      const { fingerprint: _fp, configuredAt: _at, configuredBy: _by, ...input } = profile;
      await service.configureHealth(scope, setup.ceo.id, { ...input, contains: ["changed"] }, 1);
    }
    now = new Date(now.getTime() + (fault === "gap" ? 7000 : 1000));
    await service.tick(scope);
    const state = await service.status(scope, f.id);
    expect(state.incident.state).toBe("investigating");
    expect((state.observation as { state: string }).state).toBe(fault === "recurrence" ? "recurrence" : "blocked");
    const calls = reads;
    now = new Date(now.getTime() + 10000);
    await service.tick(scope);
    expect(reads).toBe(calls);
  },
);
it("requires a full-duration mandate and denies changed repair targets before execution", async () => {
  const f = await fixture();
  await service.repair(scope, f.id, repairInput(f));
  await approve(f.actionId);
  config = { ...config, serviceTargets: [{ ...config.serviceTargets[0]!, resourceName: "different.service" }] };
  await expect(service.repair(scope, f.id, repairInput(f))).rejects.toThrow("incident_target_changed");
  await expect(readFile(path.join(directory, "broker-calls.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  const short = await repo.createMandate({
    id: randomUUID(),
    version: 1,
    scope,
    allowedToolIds: ["incident.check"],
    targetIds: [profile.targetId],
    parameterConstraints: {},
    expiresAt: new Date(now.getTime() + 1000).toISOString(),
    maxAttempts: 1,
    maxDurationSeconds: 2,
    maxCostUsdMicros: "0",
  });
  expect((await service.check(scope, f.id, { ...checkInput(f), mandateId: short.id })).state).toBe("failed");
  expect(reads).toBe(0);
});
it("runtime service tools recheck exact persisted action identity without a nested journal", async () => {
  const f = await fixture(),
    tool = incidentRuntimeTools(repo, directory, { configuration: async () => config, now: () => now }).find(
      (t) => t.id === "incident.repair",
    )!,
    args = { targetId: profile.targetId, targetConfigSha256: sha256(config.serviceTargets[0]) };
  const action: ToolAction & { targetId: string } = {
    id: randomUUID(),
    runId: randomUUID(),
    orderId: f.id,
    scope,
    toolId: tool.id,
    toolVersion: 1,
    args,
    argumentsSha256: sha256(args),
    status: "running",
    mandateId: f.mandateId,
    mandateVersion: 1,
    evidenceRefs: [],
    targetId: profile.targetId,
  };
  await expect(tool.execute(args, action)).rejects.toThrow();
  const initial = await repo.putDocument(scope, "action", action.id, { ...action, status: "proposed" });
  const approved = await repo.approve(scope, {
    companyId: scope.companyId,
    orderId: f.id,
    mandateId: f.mandateId,
    mandateVersion: 1,
    actionId: action.id,
    targetId: profile.targetId,
    argumentsSha256: action.argumentsSha256,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  });
  action.approvalId = approved.id;
  await repo.putDocument(scope, "action", action.id, action, { expectedRevision: initial.revision });
  await expect(tool.execute({ ...args, targetConfigSha256: "0".repeat(64) }, action)).rejects.toThrow();
  expect(((await tool.execute(args, action)) as { state: string }).state).toBe("succeeded");
  expect(await readFile(path.join(directory, "broker-calls.txt"), "utf8")).toBe("restart\n");
});
async function smtpFixture() {
  const { createServer } = await import("node:tls"),
    { fileURLToPath } = await import("node:url"),
    sockets = new Set<import("node:tls").TLSSocket>(),
    messages: string[] = [];
  const server = createServer(
    {
      key: await readFile(new URL("./worker-fixtures/key.pem", import.meta.url)),
      cert: await readFile(new URL("./worker-fixtures/cert.pem", import.meta.url)),
    },
    (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {});
      socket.write("220 localhost SMTP fixture\r\n");
      let buffer = "",
        inData = false,
        message = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        let cut: number;
        while ((cut = buffer.indexOf("\r\n")) >= 0) {
          const line = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          if (inData) {
            if (line === ".") {
              messages.push(message);
              inData = false;
              socket.write("250 accepted\r\n");
            } else message += line + "\r\n";
            continue;
          }
          if (/^EHLO|^HELO/.test(line)) socket.write("250-localhost\r\n250 AUTH PLAIN\r\n");
          else if (line.startsWith("AUTH PLAIN ")) socket.write("235 authenticated\r\n");
          else if (line === "DATA") {
            inData = true;
            message = "";
            socket.write("354 end\r\n");
          } else if (line === "QUIT") socket.end("221 bye\r\n");
          else socket.write("250 OK\r\n");
        }
      });
    },
  );
  server.on("tlsClientError", () => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  config = configSchema.parse({
    ...config,
    mailConnections: [
      {
        id: randomUUID(),
        scope,
        host: "127.0.0.1",
        port: (server.address() as { port: number }).port,
        username: "fixture",
        secretRef: { provider: "proton-pass", shareId: "fixture", itemId: "fixture", field: "password" },
        from: "crew@example.invalid",
        tlsMode: "implicit",
        tlsCaFile: fileURLToPath(new URL("./worker-fixtures/cert.pem", import.meta.url)),
        enabledTools: ["mail.send"],
      },
    ],
  });
  return {
    messages,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
it("sends exact approved incident mail to a real TLS sink once and preserves accepted versus delivered", async () => {
  const smtp = await smtpFixture();
  try {
    const f = await fixture(),
      mail = config.mailConnections[0]!,
      input = {
        actionId: randomUUID(),
        mandateId: f.mandateId,
        mandateVersion: 1,
        targetId: mail.id,
        targetConfigSha256: sha256(mail),
        to: "customer@example.invalid",
        subject: "Incident update",
        content: "We are investigating the service failure.",
        incidentState: "investigating",
      };
    expect((await service.customerMessage(scope, f.id, input)).state).toBe("approval");
    expect(smtp.messages).toHaveLength(0);
    await approve(input.actionId);
    expect((await service.customerMessage(scope, f.id, input)).data).toMatchObject({
      effectStatus: "accepted",
      data: { delivered: false },
    });
    expect(smtp.messages[0]).toContain(input.content);
    await service.customerMessage(scope, f.id, input);
    expect(smtp.messages).toHaveLength(1);
  } finally {
    await smtp.close();
  }
});
it("revalidates the incident after asynchronous secret resolution and rejects a now-stale customer message", async () => {
  const smtp = await smtpFixture();
  try {
    const f = await fixture(),
      mail = config.mailConnections[0]!,
      input = {
        actionId: randomUUID(),
        mandateId: f.mandateId,
        mandateVersion: 1,
        targetId: mail.id,
        targetConfigSha256: sha256(mail),
        to: "customer@example.invalid",
        subject: "Incident update",
        content: "We are investigating the service failure.",
        incidentState: "investigating",
      };
    await service.customerMessage(scope, f.id, input);
    await approve(input.actionId);
    const changing = new IncidentService({
      repo,
      directory,
      configuration: async () => config,
      now: () => now,
      secrets: {
        resolve: async () => {
          const record = await repo.getDocument(scope, "incident", f.id);
          await repo.putDocument(
            scope,
            "incident",
            f.id,
            { ...(record!.data as object), state: "blocked" },
            { expectedRevision: record!.revision },
          );
          return "fixture-password";
        },
      },
    });
    expect((await changing.customerMessage(scope, f.id, input)).state).toBe("failed");
    expect(smtp.messages).toHaveLength(0);
  } finally {
    await smtp.close();
  }
});

it("does not count a slow successful response as uninterrupted observation", async () => {
  const f = await fixture();
  await repair(f);
  await service.check(scope, f.id, checkInput(f));
  now = new Date(now.getTime() + 1000);
  probeAdvanceMs = 4000;
  await service.tick(scope);
  expect((await service.status(scope, f.id)).incident.state).toBe("investigating");
});
it("invalidates active observation before another approved repair", async () => {
  const f = await fixture();
  await repair(f);
  await service.check(scope, f.id, checkInput(f));
  const next = { ...f, actionId: randomUUID() };
  await repair(next);
  expect((await service.status(scope, f.id)).observation).toMatchObject({ state: "blocked", reason: "repair_started" });
  const before = reads;
  now = new Date(now.getTime() + 1000);
  await service.tick(scope);
  expect(reads).toBe(before);
});
