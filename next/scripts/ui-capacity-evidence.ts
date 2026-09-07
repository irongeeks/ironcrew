/** Isolated real SQLite + HTTP/UI capacity and accessibility acceptance. No provider or API mocking. */
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir, cpus, platform, release, arch } from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { Repository } from "../packages/persistence/src/index.ts";
import { createApp } from "../apps/control/app.ts";
import { hashPassword } from "../apps/control/auth.ts";
const evidence = path.resolve("docs/test-evidence/ui-capacity");
await mkdir(evidence, { recursive: true });
const directory = await mkdtemp(path.join(tmpdir(), "ironcrew-ui-capacity-"));
const repo = await Repository.open(path.join(directory, "company.sqlite"));
const server = createServer();
const browser = await chromium.launch();
const report: Record<string, unknown> = {
  measuredAt: new Date().toISOString(),
  device: { cpu: cpus()[0]?.model, platform: platform(), release: release(), arch: arch() },
  dataScope:
    "Dedicated temporary local company; exactly 1000 orders created via authenticated HTTP API. No external provider calls or API interception.",
  compression:
    "Gzip-equivalent budget using node:zlib gzipSync on actual loaded HTTP response bodies; local Express serves identity encoding. This is not a claim of on-wire HTTP compression.",
  checks: [],
};
const checks = report.checks as Record<string, unknown>[];
try {
  await repo.setup({
    companyName: "IronCrew · Kapazitätsabnahme",
    ceoName: "Lokaler Abnahmetest",
    passwordHash: await hashPassword("local-capacity-only-password"),
    timezone: "Europe/Berlin",
    budgetLimitUsdMicros: "0",
  });
  const setup = (await repo.setupState())!,
    scope = { companyId: setup.company.id, areaId: setup.areas[0]!.id };
  await repo.putDocument(scope, "setup-progress", setup.company.id, { step: 8, data: {} });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  server.on("request", createApp({ repo, directory, publicOrigin: origin, webDirectory: path.resolve("dist/web") }));
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  const resourceResponses = new Map<
    string,
    Promise<{ url: string; type: string; bytes: number; gzipBytes: number; sha256: string }>
  >();
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.origin !== origin || url.pathname.startsWith("/api/") || response.status() !== 200) return;
    resourceResponses.set(
      url.pathname,
      response
        .body()
        .then((bytes) => ({
          url: url.pathname,
          type: response.headers()["content-type"] ?? "",
          bytes: bytes.length,
          gzipBytes: gzipSync(bytes).length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        }))
        .catch((error) => ({
          url: url.pathname,
          type: "capture_error",
          bytes: 0,
          gzipBytes: 0,
          sha256: String(error),
        })),
    );
  });
  await page.goto(`${origin}/orders`);
  await page.getByLabel("Passwort", { exact: true }).fill("local-capacity-only-password");
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Aufträge", exact: true })).toBeVisible();
  const initial = await Promise.all(resourceResponses.values());
  assert(!initial.some((resource) => resource.type === "capture_error"), "Initial response body capture failed");
  const js = initial.filter((resource) => /javascript/.test(resource.type));
  const initialJsBytes = js.reduce((sum, resource) => sum + resource.gzipBytes, 0);
  checks.push({
    name: "non3d-initial-javascript",
    actualGzipBytes: initialJsBytes,
    maximumBytes: 350 * 1024,
    pass: initialJsBytes <= 350 * 1024,
    resources: js,
  });
  assert(initialJsBytes <= 350 * 1024, "Non-3D initial JS budget exceeded");
  assert(!initial.some((resource) => resource.url.includes("/Hall-")), "3D loaded on non-3D route");
  const axePath = path.resolve(
    process.env.IRONCREW_AXE_SOURCE ?? ".var/ui-validation/node_modules/axe-core/axe.min.js",
  );
  const axeSource = await readFile(axePath, "utf8");
  report.axe = {
    version: "4.10.3",
    sha256: createHash("sha256").update(axeSource).digest("hex"),
    scope: "Automated WCAG2/2.1/2.2 A/AA DOM checks; not a physical screenreader listening test.",
  };
  const accessibility: unknown[] = [];
  const viewports = [
    { width: 1440, height: 900 },
    { width: 1024, height: 768 },
    { width: 390, height: 844 },
  ];
  async function inspect(state: string) {
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await page.evaluate(() => {
        (document.activeElement as HTMLElement)?.blur();
        scrollTo(0, 0);
      });
      assert(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        `${state} horizontal overflow at ${viewport.width}`,
      );
      await page.screenshot({ path: path.join(evidence, `${state}-${viewport.width}.png`), fullPage: true });
      await page.evaluate(axeSource);
      const result = await page.evaluate(async () => {
        const axe = (
          window as unknown as {
            axe: {
              run: (options: unknown) => Promise<{
                violations: {
                  id: string;
                  impact: string;
                  description: string;
                  help: string;
                  nodes: { html: string; target: string[]; failureSummary: string }[];
                }[];
                passes: unknown[];
                incomplete: unknown[];
              }>;
            };
          }
        ).axe;
        const output = await axe.run({
          runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] },
        });
        return {
          violations: output.violations,
          passedRules: output.passes.length,
          incompleteRules: output.incomplete.length,
        };
      });
      accessibility.push({ state, viewport, ...result });
    }
  }
  await inspect("orders-empty");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${origin}/hq`);
  await expect(page.locator('[data-crew-assets="verified"]')).toBeVisible();
  await expect(page.locator("canvas")).toBeVisible();
  await expect.poll(() => resourceResponses.has("/brand/emblem.png")).toBe(true);
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
  const hqAssets = await Promise.all(resourceResponses.values());
  assert(!hqAssets.some((resource) => resource.type === "capture_error"), "HQ response body capture failed");
  const hqBytes = hqAssets.reduce((sum, resource) => sum + resource.gzipBytes, 0);
  checks.push({
    name: "hq-initial-assets",
    actualGzipBytes: hqBytes,
    maximumBytes: 15 * 1024 * 1024,
    pass: hqBytes <= 15 * 1024 * 1024,
    resources: hqAssets,
  });
  assert(hqBytes <= 15 * 1024 * 1024, "HQ asset budget exceeded");
  // Capture a genuinely empty HQ at each mandated viewport. Reload applies compact-first mobile behavior.
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Alles im Blick." })).toBeVisible();
    if (viewport.width >= 768) {
      await expect(page.locator('[data-crew-assets="verified"]')).toBeVisible();
      await expect(page.locator("canvas")).toBeVisible();
    } else await expect(page.getByRole("button", { name: "3D", exact: true })).toBeVisible();
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: path.join(evidence, `hq-empty-${viewport.width}.png`), fullPage: true });
  }
  const session = (await (await context.request.get(`${origin}/api/v1/session`)).json()) as { csrfToken: string };
  await page.goto("about:blank");
  const started = performance.now();
  const created: { id: string; revision: number }[] = [];
  for (let batch = 0; batch < 100; batch++) {
    const values = await Promise.all(
      Array.from({ length: 10 }, async (_, offset) => {
        const index = batch * 10 + offset;
        const response = await context.request.post(`${origin}/api/v1/orders`, {
          headers: { Origin: origin, "X-CSRF-Token": session.csrfToken, "Idempotency-Key": randomUUID() },
          data: {
            scope,
            kind: "research",
            goal: `Kapazitätsprüfung ${String(index + 1).padStart(4, "0")} · Dokumentierte lokale Recherche`,
            budgetLimitUsdMicros: "0",
            leadEmployeeId: setup.employees[index % 9]!.id,
            acceptanceCriteria: ["Ausschließlich lokaler Abnahme-Datensatz"],
          },
        });
        assert(response.ok(), `Create order failed ${response.status()} ${await response.text()}`);
        return response.json() as Promise<{ id: string; revision: number }>;
      }),
    );
    created.push(...values);
  }
  let total = 0,
    cursor: string | null = null;
  do {
    const result = (await (
      await context.request.get(`${origin}/api/v1/orders${cursor ? `?cursor=${cursor}` : ""}`)
    ).json()) as { items: unknown[]; nextCursor: string | null };
    total += result.items.length;
    cursor = result.nextCursor;
  } while (cursor);
  assert.equal(total, 1000);
  report.dataset = {
    count: total,
    creation: "1000 POST /api/v1/orders, 10 concurrent requests per batch; paginated GET count verified",
    creationMs: performance.now() - started,
  };
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${origin}/orders`);
  await expect(page.locator('a[href^="/orders/"]')).toHaveCount(1000, { timeout: 30000 });
  await page.evaluate(() => {
    const samples: number[] = [];
    (window as unknown as { inputSamples: number[] }).inputSamples = samples;
    document.addEventListener("input", () => {
      const started = performance.now();
      // The first RAF follows React's event update; the second observes the subsequent rendered frame.
      requestAnimationFrame(() => requestAnimationFrame(() => samples.push(performance.now() - started)));
    });
  });
  const search = page.getByRole("textbox", { name: "Aufträge suchen", exact: true });
  await search.focus();
  for (let pass = 0; pass < 3; pass++) {
    await search.pressSequentially("Kapazitätsprüfung 08", { delay: 70 });
    for (let index = 0; index < 19; index++) await search.press("Backspace", { delay: 70 });
  }
  await search.fill("");
  await expect(page.locator('a[href^="/orders/"]')).toHaveCount(1000);
  const samples = await page.evaluate(() => (window as unknown as { inputSamples: number[] }).inputSamples);
  const sorted = samples.toSorted((a, b) => a - b),
    p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]!;
  checks.push({
    name: "input-response-1000-orders",
    method:
      "Input event to second requestAnimationFrame after React state update and browser render; actual keyboard typing/deletion",
    samplesMs: samples,
    sampleCount: samples.length,
    p95Ms: p95,
    maximumP95Ms: 200,
    pass: p95 < 200,
  });
  await page.evaluate(() => {
    (document.activeElement as HTMLElement)?.blur();
    scrollTo(0, 0);
  });
  await page.screenshot({ path: path.join(evidence, "orders-1000-1440.png") });
  const first = created[0]!;
  await repo.updateOrder(scope, first.id, first.revision, { status: "blocked", waitReason: "budget" });
  report.blockedSetup =
    "Existing HTTP-created order transitioned with the real Repository domain command to blocked/budget; no UI or API response fixture.";
  await page.goto(`${origin}/orders/${first.id}`);
  await expect(page.getByText("Budget fehlt", { exact: true })).toBeVisible();
  await inspect("order-blocked");
  // Exercise native focus semantics without substituting an accessibility snapshot for a screenreader session.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Kommandopalette öffnen" }).click();
  await expect(page.getByRole("combobox", { name: "Navigation und Aufträge suchen" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Kommandopalette öffnen" })).toBeFocused();
  report.keyboard = { commandPaletteFocusAndEscapeRestoration: true, priorHallSuite: "tests/e2e/hall-live.spec.ts" };
  report.accessibility = accessibility;
  await writeFile(path.join(evidence, "results.json"), JSON.stringify(report, null, 2) + "\n");
  const violations = accessibility.flatMap((item) => (item as { violations: unknown[] }).violations);
  console.log(
    JSON.stringify({
      initialJsGzipBytes: initialJsBytes,
      hqGzipBytes: hqBytes,
      orders: total,
      samples: samples.length,
      p95Ms: p95,
      axeViolations: violations.length,
    }),
  );
  assert(p95 < 200, "Input response P95 exceeded 200ms");
  assert.equal(violations.length, 0, "Automated accessibility violations found; inspect evidence");
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await repo.close();
  await rm(directory, { recursive: true, force: true });
}
