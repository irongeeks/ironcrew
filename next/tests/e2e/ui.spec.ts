import { test, expect, type Page } from "@playwright/test";
const names = [
  "Cersei Lannister",
  "Mr. Robot",
  "Morpheus",
  "Steve Jobs",
  "Tyrion Lannister",
  "Saul Goodman",
  "Karla Kolumna",
  "Der Professor",
  "Nick Fury",
];
const employees = names.map((displayName, index) => ({
  id: `crew-${index}`,
  displayName,
  role: [
    "Chief of Staff",
    "Software & Automatisierung",
    "IT-Betrieb",
    "Design",
    "Marketing",
    "Finanzen",
    "Recherche",
    "Qualität",
    "Sicherheit",
  ][index],
  persona: "Verantwortung mit nachvollziehbaren Entscheidungen.",
  appearance: "Individuelles Crewprofil",
  revision: 1,
}));
async function fixtures(page: Page, blocked = false) {
  await page.route("**/api/v1/**", (route) => {
    const url = new URL(route.request().url()),
      path = url.pathname.replace("/api/v1", "");
    const order = {
      id: "order-1",
      goal: "Recherche zur eigenen Wissensablage",
      kind: "research",
      status: blocked ? "blocked" : "planning",
      waitReason: blocked ? "budget" : undefined,
      scope: { companyId: "company-1", areaId: "area-1" },
      leadEmployeeId: "crew-6",
      budgetLimitUsdMicros: "10000000",
      acceptanceCriteria: ["Quellen vergleichen"],
      revision: 1,
      planVersion: 1,
    };
    const data: Record<string, unknown> = {
      "/session": { authenticated: true, csrfToken: "test-csrf", setupRequired: false },
      "/setup": { step: 8, data: {} },
      "/company": { id: "company-1", name: "Iron Geeks", timezone: "Europe/Berlin", revision: 1 },
      "/budget": {
        spentUsdMicros: "0",
        reservedUsdMicros: "1000000",
        availableUsdMicros: null,
        startsAt: "2026-09-01",
        endsAt: "2026-09-30",
      },
      "/employees": { items: employees, nextCursor: null },
      "/areas": { items: [{ id: "area-1", name: "Iron Geeks" }], nextCursor: null },
      "/orders": { items: [order], nextCursor: null },
      "/orders/order-1": order,
      "/orders/order-1/messages": {
        items: [{ id: "message-1", role: "user", content: "Bitte Quellen prüfen." }],
        nextCursor: null,
      },
    };
    if (path === "/events")
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: ": fixture\n\n" });
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(data[path] ?? { items: [], nextCursor: null }),
    });
  });
}
test.describe("UI contract fixtures (not live integration evidence)", () => {
  test("mobile routes preserve chat drafts and URL-selected tabs", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await fixtures(page, true);
    await page.goto("/hq");
    await expect(page.getByRole("heading", { name: "Alles im Blick." })).toBeVisible();
    await expect(page.getByText("noch ungeklärt", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole("link", { name: /Recherche zur eigenen Wissensablage/ }).click();
    await expect(page.getByText("Budget fehlt", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await page.getByRole("textbox", { name: "Nachricht", exact: true }).fill("Mein Entwurf bleibt erhalten.");
    await page.getByRole("button", { name: "Arbeitsfläche", exact: true }).click();
    await page.getByRole("link", { name: "Dateien", exact: true }).click();
    await expect(page).toHaveURL(/tab=files/);
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Nachricht", exact: true })).toHaveValue(
      "Mein Entwurf bleibt erhalten.",
    );
    await page.reload();
    await expect(page).toHaveURL(/tab=files/);
  });
  test("all nine crew profiles and English navigation are accessible", async ({ page }) => {
    await fixtures(page);
    await page.goto("/crew");
    for (const name of names) await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
    await page.getByRole("combobox", { name: "Sprache", exact: true }).selectOption("en");
    await expect(page.getByRole("link", { name: "Headquarters", exact: false })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Your crew", exact: true })).toBeVisible();
  });
  test("360px empty state has no horizontal page overflow", async ({ page }) => {
    await fixtures(page);
    await page.route("**/api/v1/orders", (route) => route.fulfill({ json: { items: [], nextCursor: null } }));
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto("/hq");
    await expect(page.getByRole("heading", { name: "Platz für deinen ersten Auftrag." })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole("button", { name: "Neuen Auftrag anlegen" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).not.toBeVisible();
  });
});
for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 390, height: 844 },
])
  test(`HQ visual fixture ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await fixtures(page, true);
    await page.setViewportSize(viewport);
    await page.goto("/hq");
    await expect(page.getByRole("heading", { name: "Alles im Blick." })).toBeVisible();
    if (viewport.width >= 768) await expect(page.locator("canvas")).toBeVisible();
    await page.screenshot({ path: `apps/web/evidence/hq-${viewport.width}.png`, fullPage: true });
  });
test("model configuration stores only SecretRefs and requires explicit live activation", async ({ page }) => {
  await fixtures(page);
  let saved: Record<string, unknown> | undefined;
  await page.route("**/api/v1/configuration", async (route) => {
    if (route.request().method() === "PUT") {
      saved = route.request().postDataJSON();
      return route.fulfill({ json: { saved: true, runtimeReady: false } });
    }
    return route.fulfill({ json: { version: 1, liveExecutionEnabled: false, connections: [] } });
  });
  await page.goto("/settings/models");
  const live = page.getByRole("checkbox", { name: "Live-Ausführung ausdrücklich aktivieren" });
  await expect(live).not.toBeChecked();
  await page
    .getByRole("textbox", { name: "Installiertes pass-cli Programm (absoluter Pfad)" })
    .fill("/usr/local/bin/pass-cli");
  await page.getByRole("textbox", { name: "Proton Pass · Share ID" }).fill("share-fixture");
  await page.getByRole("textbox", { name: "Proton Pass · Item ID" }).fill("item-fixture");
  await page.getByRole("button", { name: "Modellzugang speichern" }).click();
  await expect.poll(() => saved?.liveExecutionEnabled).toBe(false);
  expect(saved?.openrouter).toMatchObject({
    secretRef: { provider: "proton-pass", shareId: "share-fixture", itemId: "item-fixture", field: "password" },
  });
  expect(JSON.stringify(saved)).not.toContain("apiKey");
});
test("WebGL loss preserves crew navigation and order access", async ({ page }) => {
  await fixtures(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/hq");
  const canvas = page.locator("canvas");
  await expect(canvas).toBeVisible();
  await canvas.evaluate((element) => element.dispatchEvent(new Event("webglcontextlost", { cancelable: true })));
  await expect(page.getByRole("heading", { name: "Kompakte Ansicht bleibt verfügbar." })).toBeVisible();
  await expect(page.getByRole("link", { name: "CL Cersei Lannister" })).toBeVisible();
  await page.getByRole("link", { name: /Recherche zur eigenen Wissensablage/ }).click();
  await expect(page).toHaveURL(/orders\/order-1/);
});
test("human website review binds three required evidenced checks to current version", async ({ page }) => {
  await fixtures(page);
  const artifactVersionId = "00000000-0000-4000-8000-000000000123";
  await page.route("**/api/v1/orders/order-1", (route) =>
    route.fulfill({
      json: {
        id: "order-1",
        goal: "Website prüfen",
        kind: "website",
        status: "reviewing",
        revision: 1,
        planVersion: 1,
        leadEmployeeId: "crew-1",
        acceptanceCriteria: ["Mobil nutzbar"],
        budgetLimitUsdMicros: "0",
      },
    }),
  );
  await page.route("**/api/v1/orders/order-1/workflow", (route) =>
    route.fulfill({ json: { state: "built", artifactVersionId, concepts: [] } }),
  );
  let reviewed: Record<string, unknown> | undefined;
  await page.route("**/api/v1/orders/order-1/website/review", (route) => {
    reviewed = route.request().postDataJSON();
    return route.fulfill({ json: { saved: true } });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/orders/order-1");
  await page.getByText("Manuelle Prüfung protokollieren", { exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Mobile Bedienung · bestanden" })).not.toBeChecked();
  for (const label of ["Mobile Bedienung", "Funktion", "Qualität"]) {
    await page.getByRole("textbox", { name: `${label} · Prüfbeleg` }).fill(`Geprüfter Nachweis: ${label}.`);
    await page.getByRole("checkbox", { name: `${label} · bestanden` }).check();
  }
  await page.getByRole("button", { name: "Prüfung speichern", exact: true }).click();
  await expect.poll(() => reviewed?.artifactVersionId).toBe(artifactVersionId);
  expect(reviewed?.checks).toEqual([
    { name: "mobile", passed: true, evidence: "Geprüfter Nachweis: Mobile Bedienung." },
    { name: "functional", passed: true, evidence: "Geprüfter Nachweis: Funktion." },
    { name: "quality", passed: true, evidence: "Geprüfter Nachweis: Qualität." },
  ]);
  expect(reviewed).not.toHaveProperty("reviewerId");
});
test("200% CSS zoom and reduced motion preserve compact HQ interaction", async ({ page }) => {
  await fixtures(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/hq");
  await expect(page.getByRole("heading", { name: "Alles im Blick.", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Bewegung an", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Kompakte Ansicht", exact: true }).click();
  await page.evaluate(() => {
    document.documentElement.style.zoom = "2";
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(
    true,
  );
  await page.getByRole("link", { name: /Recherche zur eigenen Wissensablage/ }).click();
  await expect(page).toHaveURL(/orders\/order-1/);
  await expect(page.getByRole("heading", { name: "Recherche zur eigenen Wissensablage", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Nachricht", exact: true })).toBeVisible();
  await page.screenshot({ path: "apps/web/evidence/zoom-200-css.png", fullPage: true });
});

test("finance UI contract fixture keeps snapshots and currencies separate, exposes partial payments and original links", async ({
  page,
}) => {
  await fixtures(page);
  const scope = { companyId: "company-1", areaId: "area-1" };
  const invoices = [
    {
      id: "invoice-in",
      reference: "FIXTURE-RECEIVABLE",
      currency: "EUR",
      totalMinor: "12000",
      paidMinor: "2000",
      direction: "receivable",
      dueAt: "2026-09-01T00:00:00Z",
      observedAt: "2026-09-06T09:00:00Z",
      source: "fixture:receivables",
      disputed: false,
      paymentPause: false,
    },
    {
      id: "invoice-out",
      reference: "FIXTURE-PAYABLE",
      currency: "EUR",
      totalMinor: "5000",
      paidMinor: "0",
      direction: "payable",
      dueAt: "2026-10-01T00:00:00Z",
      observedAt: "2026-09-06T09:00:00Z",
      source: "fixture:payables",
      disputed: false,
      paymentPause: true,
    },
    {
      id: "invoice-unknown",
      reference: "FIXTURE-UNCLASSIFIED",
      currency: "USD",
      totalMinor: "700",
      paidMinor: "0",
      dueAt: "2026-10-01T00:00:00Z",
      observedAt: "2026-09-06T09:00:00Z",
      source: "fixture:unknown",
      disputed: true,
      paymentPause: false,
    },
  ];
  await page.route("**/api/v1/finance", (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: "current",
            scope,
            observedAt: "2026-09-07T10:00:00Z",
            invoices,
            bankBalance: { status: "unavailable" },
          },
          { id: "previous", scope, observedAt: "2026-09-01T10:00:00Z", invoices: [] },
        ],
        vouchers: [{ id: "voucher-1", scope, orderId: "order-1", invoice: invoices[0] }],
        nextCursor: null,
      },
    }),
  );
  await page.goto("/finance");
  const eur = page.getByRole("article", { name: "Kennzahlen EUR" });
  await expect(eur).toContainText("100,00");
  await expect(eur).toContainText("50,00");
  await expect(eur).toContainText("150,00");
  await expect(eur).toContainText("20,00");
  await expect(eur.getByText("Teilbezahlte Belege").locator("..")).toContainText("1");
  await expect(page.getByRole("article", { name: "Kennzahlen USD" })).toContainText("ungeklärt");
  await expect(page.getByRole("heading", { name: "Bankstand nicht verfügbar" })).toBeVisible();
  await expect(page.getByText("fixture:receivables", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Originalbeleg herunterladen" })).toHaveAttribute(
    "href",
    "/api/v1/finance/vouchers/voucher-1/original",
  );
  await page.getByLabel("Finanzdatenstand", { exact: true }).selectOption("previous");
  await expect(page.getByText("Dieser Datenstand enthält keine Belege.", { exact: true })).toBeVisible();
  await expect(eur).toHaveCount(0);
});

test("command palette contract fixture supports global keyboard navigation, order search and escape focus", async ({
  page,
}) => {
  await fixtures(page);
  await page.goto("/crew");
  await expect(page.getByRole("heading", { name: "Deine Crew", exact: true })).toBeVisible();
  await page.keyboard.press("Control+k");
  const query = page.getByRole("combobox", { name: "Navigation und Aufträge suchen" });
  await expect(query).toBeFocused();
  await query.fill("Wissensablage");
  await expect(page.getByRole("dialog").getByRole("option")).toHaveCount(1);
  await query.press("Enter");
  await expect(page).toHaveURL(/orders\/order-1$/);
  await page.getByRole("button", { name: "Kommandopalette öffnen" }).click();
  await expect(query).toBeFocused();
  await query.fill("Finanzen");
  await query.press("Enter");
  await expect(page).toHaveURL(/finance$/);
  const trigger = page.getByRole("button", { name: "Kommandopalette öffnen" });
  await trigger.click();
  await query.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("model rating UI contract fixture separates sample types and requires an explicit version-bound personal score", async ({
  page,
}) => {
  await fixtures(page);
  const target = {
    orderId: "order-1",
    artifactVersionId: "fixture-artifact",
    artifactSha256: "a".repeat(64),
    modelTurnId: "fixture-turn",
    modelId: "fixture/model",
    actionId: "fixture-action",
    latencyMs: null,
  };
  let rating: Record<string, unknown> | undefined;
  await page.route("**/api/v1/models/ratings", (route) =>
    route.fulfill({
      json: {
        items: [
          {
            modelId: "fixture/model",
            human: { samples: 1, qualityMean: 2 },
            agent: { samples: 3, qualityMean: 4.5 },
            latency: { samples: 0, meanMs: null },
          },
        ],
        nextCursor: null,
      },
    }),
  );
  await page.route("**/api/v1/orders/order-1/model-ratings", (route) => {
    if (route.request().method() === "POST") {
      rating = route.request().postDataJSON();
      return route.fulfill({ json: { ...rating, version: 1 } });
    }
    return route.fulfill({
      json: {
        targets: [target],
        items: rating ? [{ ...rating, version: 1, reviewerKind: "human" }] : [],
        nextCursor: null,
      },
    });
  });
  await page.goto("/settings/models");
  await expect(page.getByText("Menschliche Qualität").locator("..")).toContainText("2 · n=1");
  await expect(page.getByText("Agentenqualität").locator("..")).toContainText("4,5 · n=3");
  await expect(page.getByText("Gemessene Modelllatenz").locator("..")).toContainText("nicht gemessen · n=0");
  await page.goto("/orders/order-1");
  await page.getByText("Modellleistung bewerten", { exact: true }).click();
  const quality = page.getByLabel("Persönliche Qualitätsnote (1–5)", { exact: true });
  await expect(quality).toHaveValue("");
  await quality.selectOption("2");
  await page
    .getByLabel("Begründung der Modellbewertung", { exact: true })
    .fill("Explizite persönliche Fixturebewertung: zwei sachliche Lücken.");
  await page.getByRole("button", { name: "Persönliche Bewertung versionieren", exact: true }).click();
  await expect(page.getByText("Bewertungsversion 1 gespeichert.", { exact: true })).toBeVisible();
  expect(rating).toEqual({
    artifactVersionId: "fixture-artifact",
    modelTurnId: "fixture-turn",
    quality: 2,
    evidence: "Explizite persönliche Fixturebewertung: zwei sachliche Lücken.",
    expectedVersion: 0,
  });
  await expect(quality).toHaveValue("");
});

test("worker configuration fixture clearly blocks enrollment when TLS is not configured in DE and EN", async ({
  page,
}) => {
  await fixtures(page);
  await page.route("**/api/v1/workers/status", (route) =>
    route.fulfill({ json: { tlsConfigured: false, connectUrl: null, capabilities: [] } }),
  );
  await page.goto("/settings/workers");
  await expect(page.getByText(/Worker-TLS ist nicht eingerichtet/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Anmelden und Zugang erzeugen", exact: true })).toBeDisabled();
  await page.getByRole("combobox", { name: "Sprache", exact: true }).selectOption("en");
  await expect(page.getByText(/Worker TLS is not configured/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Enroll and issue credentials", exact: true })).toBeDisabled();
});

test("original document fixture blocks a checksum mismatch before rendering", async ({ page }) => {
  await fixtures(page);
  await page.route("**/api/v1/orders/order-1", (route) =>
    route.fulfill({
      json: {
        id: "order-1",
        kind: "finance",
        goal: "Checksum fixture",
        status: "planning",
        revision: 1,
        scope: { companyId: "company-1", areaId: "area-1" },
      },
    }),
  );
  await page.route("**/api/v1/finance", (route) =>
    route.fulfill({
      json: {
        snapshots: [],
        vouchers: [
          {
            id: "voucher-fixture",
            orderId: "order-1",
            originalSha256: "0".repeat(64),
            originalMediaType: "application/pdf",
            invoice: { reference: "Corrupt fixture" },
          },
        ],
      },
    }),
  );
  await page.route("**/api/v1/finance/vouchers/voucher-fixture/original", (route) =>
    route.fulfill({ contentType: "application/pdf", body: "%PDF-1.4 corrupt fixture" }),
  );
  await page.goto("/orders/order-1?tab=overview");
  await page.getByLabel("Gespeicherten Beleg auswählen", { exact: true }).selectOption("voucher-fixture");
  await expect(page.getByText("Prüfsumme stimmt nicht. Vorschau gesperrt.", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("complementary", { name: "Sichere Originalbelegvorschau", exact: true }).locator("canvas,img"),
  ).toHaveCount(0);
});

test("GLB asset pipeline loads nine checksum-verified local drafts with reduced motion", async ({ page }) => {
  await fixtures(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/hq");
  await expect(page.locator('[data-crew-assets="verified"]')).toBeVisible();
  await expect(page.locator("canvas")).toBeVisible();
  await expect(page.getByRole("button", { name: "Bewegung an", exact: true })).toBeVisible();
  const manifest = await (await page.request.get("/crew/manifest.json")).json();
  expect(manifest.models).toHaveLength(9);
  expect(manifest.finalApproved).toBe(false);
  await page.screenshot({ path: "apps/web/evidence/hq-glb-local-drafts.png", fullPage: true });
});

test("GLB asset checksum failure retains an explicit procedural fallback and crew navigation", async ({ page }) => {
  await fixtures(page);
  // This case checks fallback rendering and access; animation/FPS have their own live tests.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/crew/cersei-lannister.glb", (route) =>
    route.fulfill({ contentType: "model/gltf-binary", body: "tampered local fixture" }),
  );
  await page.goto("/hq");
  await expect(page.locator('[data-crew-assets="fallback"]')).toBeVisible();
  await expect(page.locator('[data-crew-assets="fallback"]')).toHaveAttribute("data-motion", "reduced");
  await expect(page.getByText(/GLB nicht verfügbar, Ersatzdarstellung aktiv/)).toBeVisible();
  await expect(page.locator("canvas")).toBeVisible();
  const profile = page.getByRole("link", { name: "CL Cersei Lannister", exact: true });
  await expect(profile).toBeVisible();
  await profile.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/crew\/crew-0$/);
  await expect(page.getByRole("heading", { name: "Cersei Lannister", exact: true })).toBeVisible();
});
