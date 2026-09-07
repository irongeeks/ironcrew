import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { extract } from "tar";
import { Repository } from "../packages/persistence/src/index.ts";
import { WebsiteWorkflow } from "../packages/domain/workflows/website.ts";
import { createPreviewApp } from "../apps/control/preview.ts";
const input = path.resolve(process.argv[2] ?? ".var/isolation-lab/evidence"),
  output = path.resolve(process.argv[3] ?? "docs/test-evidence");
const directory = await mkdtemp(path.join(tmpdir(), "ironcrew-built-browser-"));
await mkdir(output, { recursive: true });
const artifact = JSON.parse(await readFile(path.join(input, "react-artifact.json"), "utf8")) as {
  id: string;
  scope: unknown;
};
const site = path.join(directory, "sites", artifact.id);
await mkdir(site, { recursive: true });
await extract({ file: path.join(input, "react.tar.gz"), cwd: site });
const repo = await Repository.open(path.join(directory, "company.sqlite"));
const setup = await repo.setup({
    companyName: "Browser build lab",
    ceoName: "CEO",
    passwordHash: "fixture",
    timezone: "UTC",
    budgetLimitUsdMicros: "0",
  }),
  scope = { companyId: setup.company.id, areaId: setup.areas[0]!.id };
await repo.putDocument(scope, "artifact", artifact.id, { ...artifact, scope });
const preview = createPreviewApp(new WebsiteWorkflow(repo, directory)).listen(0, "127.0.0.1");
await once(preview, "listening");
const previewPort = (preview.address() as { port: number }).port;
const parent = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(
    `<iframe title="Isolated website" sandbox="allow-scripts" src="http://127.0.0.1:${previewPort}/${artifact.id}/" style="width:100%;height:600px;border:0"></iframe>`,
  );
}).listen(0, "127.0.0.1");
await once(parent, "listening");
const parentPort = (parent.address() as { port: number }).port;
const child = spawn(process.execPath, [path.join(site, "server.mjs")], {
  cwd: site,
  env: { PORT: "0" },
  stdio: ["ignore", "pipe", "pipe", "ipc"],
});
const [ready] = await Promise.race([
  once(child, "message"),
  once(child, "exit").then(() => {
    throw new Error("Selfhost failed to start");
  }),
]);
const selfhostPort = (ready as { port: number }).port,
  browser = await chromium.launch({ headless: true });
const checks: unknown[] = [];
try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } }),
      errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${selfhostPort}/`);
    await page.getByRole("heading", { name: "Isolated website fixture" }).waitFor();
    await page.getByText("Details", { exact: true }).click();
    assert.equal(await page.getByText("Build evidence", { exact: true }).isVisible(), true);
    const layout = await page.evaluate(() => ({
      color: getComputedStyle(document.body).color,
      scroll: document.documentElement.scrollWidth,
      width: innerWidth,
      root: document.getElementById("root")?.childElementCount,
    }));
    assert.equal(layout.color, "rgb(18, 52, 86)");
    assert.ok(layout.scroll <= layout.width);
    assert.ok(layout.root);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(output, `isolated-react-${width}.png`), fullPage: true });
    checks.push({ mode: "selfhost", width, layout, pageErrors: errors });
    await page.close();
  }
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`http://127.0.0.1:${parentPort}/`);
  const frame = page.frameLocator("iframe");
  await frame.getByRole("heading", { name: "Isolated website fixture" }).waitFor();
  await frame.getByText("Details", { exact: true }).click();
  assert.equal(await frame.getByText("Build evidence", { exact: true }).isVisible(), true);
  const contentFrame = page.frames().find((f) => f.url().includes(`:${previewPort}/`))!;
  const security = await contentFrame.evaluate(async () => ({
    origin: globalThis.origin,
    parentBlocked: (() => {
      try {
        void globalThis.parent.document;
        return false;
      } catch {
        return true;
      }
    })(),
    networkBlocked: await fetch("/api/v1/setup").then(
      () => false,
      () => true,
    ),
  }));
  assert.equal(security.origin, "null");
  assert.equal(security.parentBlocked, true);
  assert.equal(security.networkBlocked, true);
  assert.equal((await fetch(`http://127.0.0.1:${previewPort}/${artifact.id}/server.mjs`)).status, 404);
  await page.screenshot({ path: path.join(output, "isolated-react-preview.png"), fullPage: true });
  checks.push({ mode: "control-preview", security });
  await page.close();
  await writeFile(
    path.join(output, "isolated-site-browser.json"),
    JSON.stringify(
      {
        testedAt: new Date().toISOString(),
        node: process.version,
        sourceArchive: "react.tar.gz",
        artifactVersionId: artifact.id,
        checks,
        passed: true,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify({ passed: true, checks }));
} finally {
  await browser.close();
  const exited = once(child, "exit");
  child.kill();
  await exited;
  await Promise.all([
    new Promise<void>((r) => preview.close(() => r())),
    new Promise<void>((r) => parent.close(() => r())),
  ]);
  await repo.close();
  await rm(directory, { recursive: true, force: true });
}
