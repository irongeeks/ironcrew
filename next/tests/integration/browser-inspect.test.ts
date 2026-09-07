import { beforeEach, afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import { chromium } from "playwright-core";
import { Repository } from "../../packages/persistence/src/index.ts";
import type { Scope, ToolAction } from "../../packages/contracts/src/index.ts";
import { sha256 } from "../../packages/domain/src/index.ts";
import { digest } from "../../packages/tools/workspace.ts";
import { hashFile } from "../../packages/operations/src/common.ts";
import { BrowserInspectService } from "../../apps/control/browser-inspect-tools.ts";
import { browserInspectInputSchema, type BrowserConfiguration } from "../../packages/tools/browser-inspect.ts";
let repo: Repository,
  directory: string,
  scope: Scope,
  action: ToolAction,
  input: { artifactPreviewId: string; expectedPackageSha256: string; viewport: "desktop" | "mobile" },
  config: BrowserConfiguration,
  server: Server,
  hits: number;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "ic-browser-inspect-"));
  repo = await Repository.open(path.join(directory, "company.sqlite"));
  const setup = await repo.setup({
    companyName: "Browser fixture",
    ceoName: "CEO",
    passwordHash: "fixture",
    timezone: "UTC",
    budgetLimitUsdMicros: "0",
  });
  scope = { companyId: setup.company.id, areaId: setup.areas[0]!.id };
  const order = await repo.createOrder(scope, {
    kind: "website",
    goal: "Inspect bounded preview",
    budgetLimitUsdMicros: "0",
  });
  hits = 0;
  server = createServer((_req, res) => {
    hits++;
    res.end("external-secret");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const external = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const id = randomUUID();
  const root = path.join(directory, "sites", id);
  await mkdir(root, { recursive: true });
  const source = {
    "index.html": `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Browser fixture</title><style>body{font-family:sans-serif;margin:24px}h1{color:#237}img{width:20px}@media(max-width:600px){h1{width:800px}}</style></head><body><h1>Geschützte Vorschau</h1><p id="proof">Script pending</p><img src="${external}/image" alt="Blocked external fixture"><script type="module" src="./app.mjs"></script></body></html>`,
    "app.mjs": `document.querySelector('#proof').textContent='Script executed in '+globalThis.origin;fetch('${external}/fetch').catch(()=>{});try{new WebSocket('${external.replace("http:", "ws:")}/ws')}catch{};try{localStorage.setItem('secret','must fail')}catch{document.body.dataset.storage='blocked'};`,
  };
  const files = Object.entries(source).map(([file, content]) => ({
    path: file,
    sha256: digest(content),
    bytes: Buffer.byteLength(content),
  }));
  for (const [file, content] of Object.entries(source)) await writeFile(path.join(root, file), content);
  const packageSha256 = digest(JSON.stringify(files));
  await repo.putDocument(
    scope,
    "artifact",
    id,
    {
      id,
      orderId: order.id,
      scope,
      sha256: digest(source["index.html"]),
      packageSha256,
      stack: "react",
      previewPath: "index.html",
      files,
    },
    { immutable: true },
  );
  input = { artifactPreviewId: id, expectedPackageSha256: packageSha256, viewport: "desktop" };
  const mandateId = randomUUID();
  await repo.createMandate({
    id: mandateId,
    version: 1,
    scope,
    allowedToolIds: ["browser.inspect"],
    targetIds: [order.id],
    parameterConstraints: {},
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    maxAttempts: 10,
    maxDurationSeconds: 60,
    maxCostUsdMicros: "0",
  });
  action = {
    id: randomUUID(),
    runId: randomUUID(),
    orderId: order.id,
    scope,
    toolId: "browser.inspect",
    toolVersion: 1,
    args: input,
    argumentsSha256: sha256(input),
    status: "running",
    mandateId,
    mandateVersion: 1,
    evidenceRefs: [],
  };
  await repo.putDocument(scope, "action", action.id, { ...action, targetId: order.id });
  // Test harness explicitly chooses the installed Playwright Chromium. Production has no fallback.
  const executable = process.env.IRONCREW_TEST_CHROMIUM ?? chromium.executablePath();
  config = { executable, executableSha256: await hashFile(executable) };
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await repo.close();
  await rm(directory, { recursive: true, force: true });
});
const service = () => new BrowserInspectService({ repo, directory, configuration: async () => config });
it("creates actual sandboxed screenshot/DOM evidence with no external HTTP or session and replays once", async () => {
  const report = (await service().inspect(input, action)) as {
    id: string;
    screenshotSha256: string;
    domSha256: string;
    state: string;
    checks: Record<string, boolean>;
    sandboxEnabled: boolean;
  };
  expect(report).toMatchObject({
    state: "review_required",
    sandboxEnabled: true,
    checks: { opaqueOrigin: true, noSessionStorage: true, headingPresent: true },
  });
  expect(hits).toBe(0);
  const image = await readFile(path.join(directory, "blobs", report.screenshotSha256));
  expect(image.subarray(1, 4).toString()).toBe("PNG");
  const dom = await readFile(path.join(directory, "blobs", report.domSha256), "utf8");
  expect(dom).toContain("Script executed in null");
  expect(dom).not.toContain("external-secret");
  expect(await service().inspect(input, action)).toEqual(report);
  expect(await repo.listDocuments(scope, "browser-inspection")).toHaveLength(1);
  expect(await repo.listDocuments(scope, "artifact")).toHaveLength(3);
  if (process.env.IRONCREW_BROWSER_EVIDENCE) {
    await mkdir(process.env.IRONCREW_BROWSER_EVIDENCE, { recursive: true });
    await writeFile(
      path.join(process.env.IRONCREW_BROWSER_EVIDENCE, "inspection.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
    await writeFile(path.join(process.env.IRONCREW_BROWSER_EVIDENCE, "screenshot.png"), image);
    await writeFile(path.join(process.env.IRONCREW_BROWSER_EVIDENCE, "dom.json"), dom);
    const original = await repo.getDocument(scope, "artifact", input.artifactPreviewId);
    await writeFile(
      path.join(process.env.IRONCREW_BROWSER_EVIDENCE, "source-artifact.json"),
      JSON.stringify(original!.data, null, 2) + "\n",
    );
    await mkdir(path.join(process.env.IRONCREW_BROWSER_EVIDENCE, "source"), { recursive: true });
    for (const file of ["index.html", "app.mjs"])
      await writeFile(
        path.join(process.env.IRONCREW_BROWSER_EVIDENCE, "source", file),
        await readFile(path.join(directory, "sites", input.artifactPreviewId, file)),
      );
  }
}, 30000);
it("rejects arbitrary navigation, wrong scope, stale package and absent administrative capability", async () => {
  expect(() => browserInspectInputSchema.parse({ ...input, url: "https://example.org" })).toThrow();
  await expect(
    service().inspect(input, { ...action, scope: { ...scope, areaId: randomUUID() } }),
  ).rejects.toMatchObject({ code: "scope_denied" });
  await expect(service().inspect({ ...input, expectedPackageSha256: "0".repeat(64) }, action)).rejects.toMatchObject({
    code: "browser_action_binding",
  });
  await expect(
    new BrowserInspectService({ repo, directory, configuration: async () => undefined }).inspect(input, action),
  ).rejects.toMatchObject({ code: "browser_capability_missing" });
});
it("blocks modified artifact bytes and a changed browser binary before launch", async () => {
  config = { ...config, executableSha256: "0".repeat(64) };
  await expect(service().inspect(input, action)).rejects.toMatchObject({ code: "browser_binary_unverified" });
  await writeFile(path.join(directory, "sites", input.artifactPreviewId, "app.mjs"), "changed");
  await expect(service().inspect(input, action)).rejects.toMatchObject({ code: "artifact_corrupt" });
  expect(await repo.listDocuments(scope, "browser-inspection")).toHaveLength(0);
});

it("records real mobile overflow instead of marking every screenshot as successful QA", async () => {
  input = { ...input, viewport: "mobile" };
  action = { ...action, id: randomUUID(), args: input, argumentsSha256: sha256(input) };
  await repo.putDocument(scope, "action", action.id, { ...action, targetId: action.orderId });
  const report = (await service().inspect(input, action)) as {
    state: string;
    checks: { noHorizontalOverflow: boolean };
    domSha256: string;
    screenshotSha256: string;
  };
  expect(report.state).toBe("review_required");
  expect(report.checks.noHorizontalOverflow).toBe(false);
  const dom = JSON.parse(await readFile(path.join(directory, "blobs", report.domSha256), "utf8"));
  expect(dom.width).toBe(390);
  if (process.env.IRONCREW_BROWSER_EVIDENCE) {
    await writeFile(
      path.join(process.env.IRONCREW_BROWSER_EVIDENCE, "mobile.png"),
      await readFile(path.join(directory, "blobs", report.screenshotSha256)),
    );
    await writeFile(
      path.join(process.env.IRONCREW_BROWSER_EVIDENCE, "mobile-inspection.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
    await writeFile(path.join(process.env.IRONCREW_BROWSER_EVIDENCE, "mobile-dom.json"), JSON.stringify(dom));
  }
}, 30000);
it("does not publish evidence when its mandate is revoked during the inspection", async () => {
  let loaded = 0;
  const inspect = new BrowserInspectService({
    repo,
    directory,
    configuration: async () => {
      if (++loaded === 2) await repo.revokeMandate(scope, action.mandateId, action.mandateVersion);
      return config;
    },
  });
  await expect(inspect.inspect(input, action)).rejects.toMatchObject({ code: "mandate_revoked" });
  expect(await repo.listDocuments(scope, "browser-inspection")).toHaveLength(0);
  expect(await repo.listDocuments(scope, "artifact")).toHaveLength(1);
}, 30000);
