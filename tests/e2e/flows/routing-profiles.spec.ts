import { test, expect, type APIRequestContext } from "@playwright/test";
import { establishSession, expectOkJson } from "../fixtures/test-helpers";
import type { RoutingSnapshot } from "../../../src/shared/routing-profiles";
import type { Agent } from "../../../src/ironcrew/types";

const endpoint = "/api/crew/routing";
const cleanups = new Map<string, (request: APIRequestContext) => Promise<void>>();

async function snapshot(request: APIRequestContext): Promise<RoutingSnapshot> {
  return expectOkJson<RoutingSnapshot>(await request.get(endpoint), "Read routing configuration");
}

test.afterEach(async ({ request }, testInfo) => {
  // A separate teardown budget preserves the original UI failure on timeout.
  const cleanup = cleanups.get(testInfo.testId);
  cleanups.delete(testInfo.testId);
  await cleanup?.(request);
});

test("persists an owner-edited model profile and an existing agent binding through reload", async ({
  page,
  request,
}, testInfo) => {
  const csrf = await establishSession(request);
  const headers = { "x-csrf-token": csrf };
  const before = await snapshot(request);
  const { agents } = await expectOkJson<{ agents: Agent[] }>(await request.get("/api/crew/agents"), "Read seed agents");
  const agent = agents.find((item) => item.key === "cto") ?? agents[0];
  expect(agent, "An existing seed agent must be available").toBeDefined();
  const vessel = before.vessels.find((item) => item.runtime_provider === "mock");
  expect(vessel, "This test requires the existing MockRuntime vessel and never invokes a provider login").toBeDefined();
  const originalBinding = before.bindings.find((item) => item.agentId === agent.id)?.profileKey ?? null;
  const coding = before.config.profiles.find((profile) => profile.key === "coding")!;
  cleanups.set(testInfo.testId, async (request) => {
    // Unbind first so an originally unconfigured profile can be restored safely.
    await expectOkJson(
      await request.put(`${endpoint}/agents/${agent.id}`, { headers, data: { profileKey: null } }),
      "Clear test binding",
    );
    const current = await snapshot(request);
    await expectOkJson(
      await request.put(endpoint, { headers, data: { expectedRevision: current.revision, config: before.config } }),
      "Restore routing configuration",
    );
    if (originalBinding) {
      await expectOkJson(
        await request.put(`${endpoint}/agents/${agent.id}`, { headers, data: { profileKey: originalBinding } }),
        "Restore original agent binding",
      );
    }
  });

  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.getByTestId("open-routing").click();
  const panel = page.getByRole("region", { name: "Modellprofile und Routing", exact: true });
  await expect(panel).toBeVisible();
  const navigation = panel.getByRole("navigation", { name: "Routing-Profile", exact: true });
  await expect(navigation.getByRole("button")).toHaveCount(9);
  // Chromium includes the visible CSS-generated unconfigured status in the name.
  await navigation
    .getByRole("button", { name: `${coding.label}${coding.primary ? "" : " · offen"}`, exact: true })
    .click();
  await panel.getByRole("textbox", { name: "Profilbezeichnung", exact: true }).fill("Coding · E2E Mockroute");
  // Role/name queries also work with native selects wrapped in visible labels.
  await panel.getByRole("combobox", { name: "Primärziel: Vessel", exact: true }).selectOption(vessel!.id);
  await panel.getByRole("textbox", { name: "Primärziel: Modell", exact: true }).fill("routing-example");
  await panel.getByRole("textbox", { name: "Primärziel: Vendor-Modell", exact: true }).fill("openai/routing-example");
  const saveResponse = page.waitForResponse(
    (response) => new URL(response.url()).pathname === endpoint && response.request().method() === "PUT",
  );
  await panel.getByRole("button", { name: "Alle Routing-Profile speichern", exact: true }).click();
  const savedResponse = await saveResponse;
  expect(savedResponse.request().headers()["content-type"]).toContain("application/json");
  expect(savedResponse.ok()).toBeTruthy();
  await expect(panel.getByRole("status").filter({ hasText: "Routing-Profile gespeichert" })).toBeVisible();
  await expect(panel).toHaveAttribute("aria-busy", "false");
  const saved = await snapshot(request);
  expect(saved.revision).toBe(before.revision + 1);
  expect(saved.config.profiles.find((profile) => profile.key === "coding")).toEqual({
    ...coding,
    label: "Coding · E2E Mockroute",
    primary: {
      vesselId: vessel!.id,
      runtimeType: "mock",
      model: "routing-example",
      vendorModel: "openai/routing-example",
    },
  });
  expect(saved.config.profiles.filter((profile) => profile.key !== "coding")).toEqual(
    before.config.profiles.filter((profile) => profile.key !== "coding"),
  );
  expect(saved.history.some((entry) => entry.revision === saved.revision)).toBe(true);

  const binding = panel.getByRole("combobox", { name: `Routingprofil für ${agent.displayName}`, exact: true });
  const saveBinding = panel.getByRole("button", { name: `Zuordnung für ${agent.displayName} speichern`, exact: true });
  if (originalBinding === "coding") {
    await binding.selectOption("");
    await saveBinding.click();
    await expect(panel.getByRole("status").filter({ hasText: "Profilzuordnung entfernt" })).toBeVisible();
    await expect(panel).toHaveAttribute("aria-busy", "false");
  }
  await binding.selectOption("coding");
  await saveBinding.click();
  await expect(panel.getByRole("status").filter({ hasText: "Profil dem Agenten zugeordnet" })).toBeVisible();
  await expect(panel).toHaveAttribute("aria-busy", "false");
  expect((await snapshot(request)).bindings).toContainEqual({ agentId: agent.id, profileKey: "coding" });

  await page.reload();
  await page.getByTestId("open-routing").click();
  await expect(panel.getByRole("textbox", { name: "Profilbezeichnung", exact: true })).toHaveValue(
    "Coding · E2E Mockroute",
  );
  await expect(panel.getByRole("combobox", { name: "Primärziel: Vessel", exact: true })).toHaveValue(vessel!.id);
  await expect(panel.getByRole("textbox", { name: "Primärziel: Modell", exact: true })).toHaveValue("routing-example");
  await expect(binding).toHaveValue("coding");
  await expect(saveBinding).toBeDisabled();
  await panel
    .locator(".routing-profile-form")
    .screenshot({ path: testInfo.outputPath("routing-profile-persisted.png") });
  const afterAgent = (
    await expectOkJson<{ agents: Agent[] }>(await request.get("/api/crew/agents"), "Read agent after routing edit")
  ).agents.find((item) => item.id === agent.id)!;
  expect(afterAgent.policy).toEqual(agent.policy);
  expect(afterAgent.professionalRole).toBe(agent.professionalRole);
});
