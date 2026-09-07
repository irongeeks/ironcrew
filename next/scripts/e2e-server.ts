import { mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { WorkerServer } from "../apps/control/worker-server.ts";
import { randomUUID } from "node:crypto";
import { ResearchService } from "../packages/domain/workflows/research.ts";
import { ResearchWatch } from "../packages/domain/workflows/research-watch.ts";
import { saveConfiguration } from "../apps/control/configuration.ts";
import { Repository } from "../packages/persistence/src/index.ts";
import { createApp } from "../apps/control/app.ts";
import { hashPassword } from "../apps/control/auth.ts";
import express from "express";
import { WebsiteWorkflow } from "../packages/domain/workflows/website.ts";
const directory = await mkdtemp(path.join(tmpdir(), "ironcrew-e2e-"));
const repo = await Repository.open(path.join(directory, "company.sqlite"));
await repo.setup({
  companyName: "IronCrew · lokale Testfirma",
  ceoName: "Test CEO",
  passwordHash: await hashPassword("local-e2e-fixture-password"),
  timezone: "Europe/Berlin",
  budgetLimitUsdMicros: "0",
});
const setup = (await repo.setupState())!;
const scope = { companyId: setup.company.id, areaId: setup.areas[0]!.id };
await repo.putDocument(scope, "setup-progress", setup.company.id, { step: 8, data: {} });
await repo.putDocument(scope, "company-settings", setup.company.id, {
  name: setup.company.name,
  locale: "de",
  timezone: "Europe/Berlin",
});
// Explicit server-side E2E fixture: local source observations, never a claimed live provider check.
const researchOrder = await repo.createOrder(scope, {
  goal: "Lokale Quellenbeobachtung E2E",
  kind: "research",
  budgetLimitUsdMicros: "0",
  leadEmployeeId: setup.employees.find((employee) => employee.seedKey === "research")!.id,
});
const targetId = randomUUID(),
  mandateId = randomUUID();
await repo.createMandate({
  id: mandateId,
  version: 1,
  scope,
  allowedToolIds: ["research.fetch"],
  targetIds: [targetId],
  parameterConstraints: {},
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
  maxAttempts: 20,
  maxDurationSeconds: 60,
  maxCostUsdMicros: "0",
});
await saveConfiguration(directory, {
  version: 1,
  liveExecutionEnabled: false,
  connections: [
    {
      id: targetId,
      provider: "research",
      scope,
      enabledTools: ["research.fetch"],
      schemaTag: "explicit-local-e2e-fixture",
    },
  ],
  gitConnections: [],
  serviceTargets: [],
  mailConnections: [],
});
let observation = "Explizite lokale Testquelle: Lieferung in drei Tagen.";
const localResearch = new ResearchService(repo, directory, {
  execute: async () => ({
    observedAt: new Date().toISOString(),
    effectStatus: "succeeded",
    evidenceRefs: [],
    data: { content: observation },
  }),
});
const source = await localResearch.fetchSource(scope, {
  targetId,
  url: "https://fixture.invalid/browser-watch",
  title: "Explizite lokale E2E-Quelle",
});
const baseline = await localResearch.create(scope, {
  orderId: researchOrder.id,
  title: "Lokaler E2E-Ausgangsbericht",
  recommendation: "Bisherige Lieferfrist beachten.",
  reasons: [{ text: "Die lokale Testquelle nennt drei Tage.", sourceIds: [source.id] }],
  comparison: "Lokale Testbeobachtung",
  methodology: "Expliziter E2E-Quellenadapter, kein externer Liveabruf.",
  sources: [source],
  assumptions: [],
  gaps: [],
  requiredDelivery: "internal",
});
const watcher = new ResearchWatch(repo, directory, localResearch);
const watch = await watcher.create(scope, {
  orderId: researchOrder.id,
  title: "Bereits geprüfte lokale Änderung",
  relevantChanges: "Änderungen der Lieferfrist",
  sources: [{ targetId, url: source.url, title: source.title }],
  cadenceSeconds: 3600,
  budgetLimitUsdMicros: "0",
  mandateId,
  mandateVersion: 1,
  predecessorArtifactId: baseline.id,
  enabled: true,
});
observation = "Explizite lokale Testquelle: Lieferung in sechs Tagen.";
await watcher.check(scope, watch.id, { checkId: randomUUID() });
const preview = express();
const sites = new WebsiteWorkflow(repo, directory);
preview.get("/:version/", async (req, res) => {
  try {
    res
      .set({
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
      })
      .send(await sites.preview(req.params.version));
  } catch {
    res.status(404).end();
  }
});
const previewServer = preview.listen(8792, "127.0.0.1");
// Real local TLS worker transport. Credentials/certificate belong only to the isolated test process.
const workerTls = createTlsServer({
  key: await readFile(new URL("../tests/integration/worker-fixtures/key.pem", import.meta.url)),
  cert: await readFile(new URL("../tests/integration/worker-fixtures/cert.pem", import.meta.url)),
});
const workerServer = await WorkerServer.create({ server: workerTls, repo, scope });
await new Promise<void>((resolve) => workerTls.listen(0, "127.0.0.1", resolve));
const workerConnectUrl = `wss://127.0.0.1:${(workerTls.address() as { port: number }).port}/api/v1/workers/connect`;
const server = createServer(
  createApp({
    repo,
    directory,
    publicOrigin: "http://127.0.0.1:8899",
    webDirectory: path.resolve("dist/web"),
    workers: async () => workerServer,
    workerConnectUrl,
  }),
);
server.listen(8899, "127.0.0.1");
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  server.closeAllConnections();
  server.close();
  previewServer.closeAllConnections();
  previewServer.close();
  await workerServer.close();
  await new Promise<void>((resolve) => workerTls.close(() => resolve()));
  await repo.close();
  await rm(directory, { recursive: true, force: true });
}
process.on("SIGTERM", () => void close());
process.on("SIGINT", () => void close());
