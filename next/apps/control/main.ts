import { discoverDueReleases } from "./release-feed-routes.ts";
import { UpdateScheduler } from "./update-scheduler.ts";
import { fileURLToPath } from "node:url";
import { productionUpdates } from "./production-update.ts";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createPreviewApp } from "./preview.ts";
import { Repository } from "../../packages/persistence/src/index.ts";
import { createApp } from "./app.ts";
import { issueSetupToken, defaultScope } from "./auth.ts";
import { configuredRuntime, readConfiguration } from "./configuration.ts";
import { WorkerServer } from "./worker-server.ts";
import { BackgroundCoordinator } from "./background.ts";
import { WebsiteWorkflow } from "../../packages/domain/workflows/website.ts";
import type { Model } from "../../packages/runtime/src/openrouter.ts";
import { acquireInstanceLock } from "../../packages/operations/src/instance-lock.ts";
import { DomainError } from "../../packages/domain/src/index.ts";
const directory = path.resolve(process.env.IRONCREW_DATA_DIR ?? ".var");
const instanceLock = await acquireInstanceLock(directory, "control");
const repo = await Repository.open(path.join(directory, "company.sqlite"));
const host = process.env.IRONCREW_HOST ?? "127.0.0.1";
const port = Number(process.env.IRONCREW_PORT ?? 8790);
const publicOrigin = process.env.IRONCREW_PUBLIC_URL ?? `http://127.0.0.1:${port}`;
const tls =
  process.env.IRONCREW_TLS_CERT && process.env.IRONCREW_TLS_KEY
    ? { cert: await readFile(process.env.IRONCREW_TLS_CERT), key: await readFile(process.env.IRONCREW_TLS_KEY) }
    : undefined;
if (!["127.0.0.1", "::1", "localhost"].includes(host) && (!publicOrigin.startsWith("https://") || !tls))
  throw new Error("External access requires TLS certificate/key and a configured HTTPS origin");
const setup = await repo.setupState();
if (!setup) {
  try {
    await readFile(path.join(directory, "setup-token.json"));
  } catch {
    const token = await issueSetupToken(directory);
    console.info(`Einmaliges lokales Setup-Token (15 Minuten): ${token}`);
  }
}
const config = await readConfiguration(directory);
const cached = setup ? await repo.listDocuments<Model>(await defaultScope(repo), "model") : [];
const updater = process.env.IRONCREW_UPDATER_CONFIG
  ? await productionUpdates({
      repo,
      directory,
      configurationPath: process.env.IRONCREW_UPDATER_CONFIG,
      entrypoint: fileURLToPath(import.meta.url),
      executable: process.execPath,
      cwd: process.cwd(),
    })
  : undefined;
await updater?.consumeResults();
let workers: WorkerServer | undefined;
const appOptions: Parameters<typeof createApp>[0] = {
  repo,
  directory,
  publicOrigin,
  releaseIdentity: updater?.releaseIdentity,
  updateExecutor: updater?.updateExecutor,
  updateConfigurationFingerprint: updater?.updateConfigurationFingerprint,
  webDirectory: path.resolve("dist/web"),
  workers: async () => {
    if (!tls) return undefined;
    if (!workers)
      workers = await WorkerServer.create({
        server: server as ReturnType<typeof createHttpsServer>,
        repo,
        directory,
        scope: await defaultScope(repo),
      });
    return workers;
  },
};
const app = createApp(appOptions);
const server = tls ? createHttpsServer(tls, app) : createHttpServer(app);
if (tls && setup)
  workers = await WorkerServer.create({
    server: server as ReturnType<typeof createHttpsServer>,
    repo,
    directory,
    scope: await defaultScope(repo),
  });
const runtime = await configuredRuntime(
  repo,
  directory,
  config,
  cached.map((d) => d.data),
  appOptions.workers,
).catch((error: unknown) => {
  if (
    !(error instanceof DomainError) ||
    !["model_secret_configuration", "model_secret_unavailable"].includes(error.code)
  )
    throw error;
  console.error("IronCrew model access is not ready", { code: error.code });
  // Keep settings accessible so an expired session or invalid path can be repaired.
  return undefined;
});
appOptions.runtime = runtime;
server.listen(port, host, () =>
  console.info(
    `IronCrew: ${publicOrigin} · eigener Kern · Liveausführung ${runtime ? "bereit (Secretzugriff geprüft)" : config.liveExecutionEnabled ? "gesperrt: Modellzugang nicht bereit" : "deaktiviert"}`,
  ),
);
const sites = new WebsiteWorkflow(repo, directory);
const previewServer = createPreviewApp(sites).listen(Number(process.env.IRONCREW_PREVIEW_PORT ?? 8792), "127.0.0.1");
const background = new BackgroundCoordinator(
  repo,
  () => (app.locals.getRuntime ? app.locals.getRuntime() : runtime),
  undefined,
  directory,
);
app.locals.pauseBackground = () => background.pause();
const updateScheduler = new UpdateScheduler({
  repo,
  apply: (scope, ceoId, planId) => app.locals.maintenanceService.applyUpdate(scope, ceoId, planId),
});
let maintenanceTask: Promise<void> | undefined;
const scheduled = setInterval(() => {
  if (maintenanceTask) return;
  maintenanceTask = (async () => {
    await background.tick();
    if (updater) await app.locals.runAdministrativeTask(updater.consumeResults);
    if (app.locals.canRunMaintenance() && (await repo.setupState())) {
      const scope = await defaultScope(repo);
      await app.locals.maintenanceService.tick(scope);
      const ceoId = (await repo.getIdentity())!.id;
      await app.locals.runAdministrativeTask(() =>
        discoverDueReleases({ repo, directory, currentVersion: updater?.releaseIdentity.version }, scope, ceoId),
      );
    }
    if (updater && !app.locals.getRuntime()?.active.size && (await repo.setupState())) {
      const scope = await defaultScope(repo);
      await app.locals.runAdministrativeTask(() => updateScheduler.tick(scope));
    }
  })()
    .catch(() => console.warn("Hintergrundprüfung fehlgeschlagen; der letzte bestätigte Stand bleibt erhalten."))
    .finally(() => {
      maintenanceTask = undefined;
    });
}, 1000);
scheduled.unref();
let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  clearInterval(scheduled);
  const backgroundStopped = background.stop();
  const currentRuntime = app.locals.getRuntime ? app.locals.getRuntime() : runtime;
  if (currentRuntime) currentRuntime.acceptingRuns = false;
  await workers?.cancelAllRemote("control_shutdown");
  // Stop accepting connections, but keep in-flight handlers and their database alive until drained.
  const serverClosed = new Promise<void>((resolve) => server.close(() => resolve()));
  const previewClosed = new Promise<void>((resolve) => previewServer.close(() => resolve()));
  await app.locals.drainWrites?.();
  await backgroundStopped;
  await maintenanceTask;
  while (currentRuntime?.active.size) await new Promise((resolve) => setTimeout(resolve, 25));
  await workers?.close();
  server.closeAllConnections();
  previewServer.closeAllConnections();
  await Promise.all([serverClosed, previewClosed]);
  await repo.close();
  await instanceLock.release();
};
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
