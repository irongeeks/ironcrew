import { test, expect } from "@playwright/test";
import { navigateTo, establishSession } from "../fixtures/test-helpers";

test.describe("Company dashboard", () => {
  test.beforeEach(async ({ page, request }) => {
    await establishSession(request);
    await page.goto("/");
    await navigateTo(page, "office");
    await expect(page.getByTestId("crew-office")).toBeVisible();
  });

  test("shows company metrics backed by the control plane", async ({ page, request }) => {
    const response = await request.get("/api/crew/dashboard");
    expect(response.ok()).toBeTruthy();
    const dashboard = await response.json();
    const metrics = page.getByRole("group", { name: "Systemkennzahlen" });
    for (const [label, value] of [
      ["Läuft", dashboard.tasks.running],
      ["Review", dashboard.tasks.review],
      ["Freigaben", dashboard.approvalsPending],
      ["Blockiert", dashboard.tasks.blocked],
      ["Agents aktiv", dashboard.agents.working],
    ] as const) {
      const metric = metrics.locator(".ic-metric").filter({ has: page.getByText(label, { exact: true }) });
      await expect(metric.locator(".ic-metric-value")).toHaveText(String(value));
    }
    await expect(page.getByTestId("command-center")).toBeVisible();
  });

  test("New Mission from another screen returns to and focuses the CEO composer", async ({ page }) => {
    await navigateTo(page, "projects");
    await page.getByRole("button", { name: /NEW MISSION/ }).click();
    await expect(page.getByTestId("crew-office")).toBeVisible();
    await expect(page.locator("#ic-composer-input")).toBeFocused();
    await page.locator("#ic-composer-input").fill("Bitte die nächste Aufgabe planen.");
    await navigateTo(page, "tasks");
    await expect(page.getByTestId("kanban")).toBeVisible();
    await navigateTo(page, "office");
    await expect(page.locator("#ic-composer-input")).toHaveValue("Bitte die nächste Aufgabe planen.");
  });
});
