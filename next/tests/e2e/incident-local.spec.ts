import { test, expect } from "@playwright/test";
test("real local incident profile, repair approval, independent HTTP observation and customer mail approval (no restart or mail sent)", async ({
  page,
}) => {
  test.setTimeout(60000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/hq");
  await page.getByLabel(/Passwort|Password/i).fill("local-e2e-fixture-password");
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Alles im Blick.", exact: true })).toBeVisible();
  const session = await (await page.request.get("/api/v1/session")).json(),
    company = await (await page.request.get("/api/v1/company")).json(),
    areas = await (await page.request.get("/api/v1/areas")).json(),
    previous = await (await page.request.get("/api/v1/configuration")).json();
  const scope = { companyId: company.id, areaId: areas.items[0].id },
    targetId = crypto.randomUUID(),
    mailId = crypto.randomUUID(),
    mandateId = crypto.randomUUID();
  const headers = () => ({ "X-CSRF-Token": session.csrfToken, "Idempotency-Key": crypto.randomUUID() });
  const config = {
    ...previous,
    liveExecutionEnabled: true,
    serviceTargets: [
      ...previous.serviceTargets,
      {
        id: targetId,
        scope,
        kind: "systemd",
        resourceName: "explicit-browser-fixture.service",
        executable: "/nonexistent/ironcrew-browser-fixture-systemctl",
      },
    ],
    mailConnections: [
      ...previous.mailConnections,
      {
        id: mailId,
        scope,
        host: "mail.fixture.invalid",
        port: 465,
        username: "explicit-browser-fixture",
        from: "sender@example.test",
        tlsMode: "implicit",
        secretRef: {
          provider: "proton-pass",
          shareId: "unused-browser-fixture",
          itemId: "unused-browser-fixture",
          field: "password",
        },
        enabledTools: ["mail.send"],
      },
    ],
  };
  try {
    expect((await page.request.put("/api/v1/configuration", { headers: headers(), data: config })).status()).toBe(200);
    const created = await page.request.post("/api/v1/orders", {
      headers: headers(),
      data: {
        scope,
        kind: "incident",
        goal: "Echte lokale Incident-Fachkette im Browser",
        budgetLimitUsdMicros: "0",
        acceptanceCriteria: ["Unabhängiger lokaler HTTP-Nachweis"],
      },
    });
    expect(created.status()).toBe(200);
    const order = await created.json();
    expect(
      (
        await page.request.post("/api/v1/mandates", {
          headers: headers(),
          data: {
            id: mandateId,
            version: 1,
            scope,
            allowedToolIds: ["incident.repair", "incident.check", "incident.customer_message"],
            targetIds: [targetId, mailId],
            parameterConstraints: {},
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
            maxAttempts: 10,
            maxDurationSeconds: 600,
            maxCostUsdMicros: "0",
          },
        })
      ).status(),
    ).toBe(200);
    await page.goto(`/orders/${order.id}`);
    await page.getByLabel("Zielsystem-ID", { exact: true }).fill(targetId);
    await page
      .getByLabel("Beobachtung", { exact: true })
      .fill("Expliziter Browserfall: keine Neustart- oder Versandfreigabe erteilen.");
    await page.getByRole("button", { name: "Vorfall initialisieren", exact: true }).click();
    const panel = page.getByRole("region", { name: "Reparatur, Prüfung und Kundeninformation", exact: true });
    await expect(panel).toBeVisible();
    await panel.getByText("Unabhängige Funktionsprüfung konfigurieren", { exact: true }).click();
    await panel
      .getByLabel("URL der unabhängigen Funktionsprüfung", { exact: true })
      .fill(new URL("/api/v1/health", page.url()).href);
    await panel.getByLabel("Erwartete Inhalte (einer je Zeile)", { exact: true }).fill('"status":"ok"');
    await panel.getByLabel("Beobachtungsdauer in Sekunden", { exact: true }).fill("30");
    await panel.getByLabel("Prüfabstand in Sekunden", { exact: true }).fill("1");
    await panel.getByLabel("Maximale Prüflücke in Sekunden", { exact: true }).fill("30");
    await panel.getByRole("button", { name: "Prüfprofil versioniert speichern", exact: true }).click();
    await expect(
      panel.getByText("Prüfabstand ≤ maximale Prüflücke < Beobachtungsdauer erforderlich.", { exact: true }),
    ).toBeVisible();
    await panel.getByLabel("Maximale Prüflücke in Sekunden", { exact: true }).fill("5");
    await panel.getByRole("button", { name: "Prüfprofil versioniert speichern", exact: true }).click();
    await expect
      .poll(
        async () =>
          (await (await page.request.get(`/api/v1/orders/${order.id}/incident/status`)).json()).healthProfile?.revision,
      )
      .toBe(1);
    await panel.getByLabel("Erwartete Inhalte (einer je Zeile)", { exact: true }).fill('"status":"ok"\n"version"');
    await panel.getByRole("button", { name: "Prüfprofil versioniert speichern", exact: true }).click();
    await expect
      .poll(
        async () =>
          (await (await page.request.get(`/api/v1/orders/${order.id}/incident/status`)).json()).healthProfile?.revision,
      )
      .toBe(2);
    expect(
      (await (await page.request.get(`/api/v1/orders/${order.id}/incident/status`)).json()).healthProfile.contains,
    ).toEqual(['"status":"ok"', '"version"']);
    await panel.getByLabel("Reparaturmandat", { exact: true }).selectOption(mandateId);
    await panel.getByLabel("Konkretes Ziel und Neustartwirkung geprüft.", { exact: true }).check();
    await panel.getByRole("button", { name: "Reparaturfreigabe anfordern", exact: true }).click();
    await expect
      .poll(
        async () =>
          (await (await page.request.get(`/api/v1/orders/${order.id}/incident/status`)).json()).pendingActions.length,
      )
      .toBe(1);
    const repair = (await (await page.request.get(`/api/v1/orders/${order.id}/incident/status`)).json())
      .pendingActions[0];
    expect(repair.toolId).toBe("incident.repair");
    expect(repair.status).toBe("proposed");
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await expect(panel.getByText(repair.id, { exact: true }).first()).toBeVisible();
    await panel.getByRole("link", { name: "Vorfallfreigabe in Entscheidungen prüfen", exact: true }).click();
    await page
      .getByRole("article")
      .filter({ has: page.getByText(repair.id, { exact: true }) })
      .getByRole("button", { name: "Ablehnen", exact: true })
      .click();
    await page.goto(`/orders/${order.id}`);
    await panel.getByLabel("Prüf- und Beobachtungsmandat", { exact: true }).selectOption(mandateId);
    await panel.getByRole("button", { name: "Reale Funktionsprüfung starten", exact: true }).click();
    await expect(panel.getByRole("heading", { name: "Beobachtungsnachweis", exact: true })).toBeVisible();
    const observed = await (await page.request.get(`/api/v1/orders/${order.id}/incident/status`)).json();
    expect(observed.observation.state).toBe("active");
    expect(observed.incident.state).toBe("observing");
    expect(observed.incident.timeline.some((event: { kind: string }) => event.kind === "functional_check")).toBe(true);
    await panel.getByRole("button", { name: "Abgeschlossene Vorfallaktion ausblenden", exact: true }).click();
    await panel.getByText("Kundeninformation vorbereiten", { exact: true }).click();
    await panel.getByLabel("Absenderpostfach der Kundeninformation", { exact: true }).selectOption(mailId);
    await panel.getByLabel("Kunden-E-Mail-Adresse", { exact: true }).fill("customer@example.test");
    await panel.getByLabel("Betreff der Kundeninformation", { exact: true }).fill("Lokaler Beobachtungsstand");
    await panel
      .getByLabel("Exakter Nachrichtentext an den Kunden", { exact: true })
      .fill(
        "Der unabhängige lokale HTTP-Check ist positiv; das Beobachtungsfenster läuft noch. Dies ist eine nicht versandte Browserfixture.",
      );
    await panel.getByLabel("Mandat für Kundeninformation", { exact: true }).selectOption(mandateId);
    await panel
      .getByLabel("Empfänger und exakten Text geprüft; eigene Versandfreigabe anfordern.", { exact: true })
      .check();
    await panel.getByRole("button", { name: "Kundenmailfreigabe anfordern", exact: true }).click();
    await expect
      .poll(
        async () =>
          (await (await page.request.get(`/api/v1/orders/${order.id}/incident/status`)).json()).pendingActions.find(
            (action: { toolId: string }) => action.toolId === "incident.customer_message",
          )?.status,
      )
      .toBe("proposed");
    const mail = (
      await (await page.request.get(`/api/v1/orders/${order.id}/incident/status`)).json()
    ).pendingActions.find((action: { toolId: string }) => action.toolId === "incident.customer_message");
    expect(mail.args.incidentState).toBe("observing");
    await panel.getByRole("link", { name: "Vorfallfreigabe in Entscheidungen prüfen", exact: true }).click();
    await page
      .getByRole("article")
      .filter({ has: page.getByText(mail.id, { exact: true }) })
      .getByRole("button", { name: "Ablehnen", exact: true })
      .click();
    const final = await (await page.request.get(`/api/v1/orders/${order.id}/incident/status`)).json();
    expect(
      final.pendingActions
        .filter((a: { toolId: string; status: string }) => a.toolId !== "incident.check")
        .every((a: { status: string }) => a.status === "denied"),
    ).toBe(true);
    await page.goto(`/orders/${order.id}`);
    await page.getByRole("combobox", { name: "Sprache", exact: true }).selectOption("en");
    await page.setViewportSize({ width: 390, height: 844 });
    const workspace = page.getByRole("button", { name: "Workspace", exact: true });
    if (await workspace.isVisible()) await workspace.click();
    const englishPanel = page.getByRole("region", {
      name: "Repair, verification and customer communication",
      exact: true,
    });
    await expect(englishPanel).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await englishPanel.screenshot({ path: "apps/web/evidence/incident-local-mobile.png" });
  } finally {
    expect((await page.request.put("/api/v1/configuration", { headers: headers(), data: previous })).status()).toBe(
      200,
    );
  }
});
