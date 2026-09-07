import { test, expect } from "@playwright/test";
test("real local OAuth profile form stores only references for Drive, Graph and mail, with explicit profile rotation", async ({
  page,
}) => {
  await page.goto("/settings/integrations");
  await page.getByLabel("Passwort", { exact: true }).fill("local-e2e-fixture-password");
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  await expect(page.getByRole("region", { name: "OAuth-Profile", exact: true })).toBeVisible();
  const session = await (await page.request.get("/api/v1/session")).json(),
    company = await (await page.request.get("/api/v1/company")).json(),
    areas = await (await page.request.get("/api/v1/areas")).json(),
    prior = await (await page.request.get("/api/v1/configuration")).json();
  const headers = () => ({ "X-CSRF-Token": session.csrfToken, "Idempotency-Key": crypto.randomUUID() }),
    scope = { companyId: company.id, areaId: areas.items[0].id };
  const drive = crypto.randomUUID(),
    graph = crypto.randomUUID(),
    mail = crypto.randomUUID();
  try {
    const seed = {
      ...prior,
      connections: [
        ...prior.connections,
        ...["gdrive", "graph"].map((provider, index) => ({
          id: index ? graph : drive,
          provider,
          scope,
          enabledTools: [index ? "graph.users.read" : "gdrive.read"],
          schemaTag: "Explicit local OAuth configuration form test",
        })),
      ],
      mailConnections: [
        ...prior.mailConnections,
        {
          id: mail,
          scope,
          host: "mail.example.invalid",
          port: 993,
          username: "oauth-form-test",
          from: "test@example.invalid",
          enabledTools: ["mail.read"],
          tlsMode: "implicit",
        },
      ],
    };
    expect((await page.request.put("/api/v1/configuration", { headers: headers(), data: seed })).status()).toBe(200);
    await page.reload();
    const panel = page.getByRole("region", { name: "OAuth-Profile", exact: true });
    const expectedTargets = [
      ...seed.connections.filter((connection: { provider: string }) =>
        ["gdrive", "graph"].includes(connection.provider),
      ),
      ...seed.mailConnections,
    ];
    const targetSelect = panel.getByLabel("Verbindung für OAuth", { exact: true });
    await expect(targetSelect.getByRole("option")).toHaveCount(expectedTargets.length + 1);
    for (const target of expectedTargets)
      await expect(targetSelect.locator(`option[value="${target.id}"]`)).toHaveCount(1);
    for (const id of [drive, graph, mail]) {
      await panel.getByLabel("Verbindung für OAuth", { exact: true }).selectOption(id);
      await panel.getByLabel("Token-Endpunkt (HTTPS)", { exact: true }).fill("https://oauth.example.invalid/token");
      await panel.getByLabel("Client ID", { exact: true }).fill("local-form-client");
      for (const title of ["Client-Secret", "Refresh-Token", "Verschlüsselungsschlüssel"]) {
        await panel.getByLabel(`${title} · Share ID`, { exact: true }).fill("explicit-local-test-share");
        await panel.getByLabel(`${title} · Item ID`, { exact: true }).fill(`${title}-reference`);
      }
      await panel.getByLabel("Provider-Scopes (einer je Zeile)", { exact: true }).fill("scope.read\noffline_access");
      await panel.getByRole("button", { name: "OAuth-Profil ausdrücklich speichern" }).click();
      let current = await (await page.request.get("/api/v1/configuration")).json();
      expect([...current.connections, ...current.mailConnections].find((c) => c.id === id).oauth).toBeUndefined();
      await panel.getByLabel(/Ich habe den Providerzugang/).check();
      await panel.getByRole("button", { name: "OAuth-Profil ausdrücklich speichern" }).click();
      await expect(panel.getByRole("status")).toContainText("OAuth-Verweise");
      current = await (await page.request.get("/api/v1/configuration")).json();
      const profile = [...current.connections, ...current.mailConnections].find((c) => c.id === id).oauth;
      expect(profile).toMatchObject({
        authorizedGeneration: null,
        clientId: "local-form-client",
        clientAuthentication: "client_secret_post",
        scopes: ["scope.read", "offline_access"],
        refreshTokenRef: {
          provider: "proton-pass",
          shareId: "explicit-local-test-share",
          itemId: "Refresh-Token-reference",
          field: "password",
        },
      });
      expect(profile).not.toHaveProperty("refreshToken");
      expect(profile).not.toHaveProperty("clientSecret");
      expect(profile).not.toHaveProperty("accessToken");
    }
    const before = await (await page.request.get("/api/v1/configuration")).json();
    const oldId = before.mailConnections.find((c: { id: string; oauth: { id: string } }) => c.id === mail).oauth.id;
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByLabel("Sprache").selectOption("en");
    const english = page.getByRole("region", { name: "OAuth profiles", exact: true });
    await english.getByLabel(/After deliberate provider reauthorization/).check();
    await english.getByLabel(/I verified provider access/).check();
    await english.getByRole("button", { name: "Explicitly save OAuth profile" }).click();
    await expect(english.getByRole("status")).toContainText("OAuth references saved");
    const after = await (await page.request.get("/api/v1/configuration")).json();
    expect(after.mailConnections.find((c: { id: string; oauth: { id: string } }) => c.id === mail).oauth.id).not.toBe(
      oldId,
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.evaluate(() => {
      (document.activeElement as HTMLElement)?.blur();
      scrollTo(0, 0);
    });
    await page.screenshot({ path: "docs/test-evidence/oauth-profile-local-mobile.png", fullPage: true });
  } finally {
    expect((await page.request.put("/api/v1/configuration", { headers: headers(), data: prior })).status()).toBe(200);
  }
});
