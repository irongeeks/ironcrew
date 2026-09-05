import { test, expect } from "@playwright/test";
import { navigateTo, establishSession } from "../fixtures/test-helpers";

test.describe("Canonical Crew Office", () => {
  test.beforeEach(async ({ page, request }) => {
    await establishSession(request);
    await page.goto("/");
    await navigateTo(page, "office");
    await expect(page.getByTestId("crew-office")).toBeVisible();
  });

  test("renders the backend crew as a modern vector office without WebGL", async ({ page, request }) => {
    const response = await request.get("/api/crew/agents");
    expect(response.ok()).toBeTruthy();
    const { agents } = (await response.json()) as { agents: Array<{ id: string; status: string }> };
    expect(agents.length).toBeGreaterThan(0);
    const office = page.getByTestId("crew-office");
    await expect(office.locator(".crew-office-floor > svg")).toBeVisible();
    await expect(office.locator("canvas")).toHaveCount(0);
    await expect(office.locator(".crew-office-person-button")).toHaveCount(agents.length);
    for (const agent of agents) {
      await expect(page.getByTestId(`office-person-${agent.id}`)).toHaveAttribute("data-status", agent.status);
    }
    await expect(page.getByRole("heading", { name: "Die Crew bei der Arbeit" })).toBeVisible();
  });

  test("opens the canonical agent details from a figure with the keyboard", async ({ page, request }) => {
    const { agents } = (await (await request.get("/api/crew/agents")).json()) as {
      agents: Array<{ id: string; displayName: string }>;
    };
    const agent = agents[0];
    const figure = page.getByTestId(`office-person-${agent.id}`).getByRole("button").first();
    await figure.focus();
    await page.keyboard.press("Enter");
    const details = page.getByRole("dialog", { name: agent.displayName, exact: true });
    await expect(details).toBeVisible();
    await expect(details.getByTestId("agent-tools-line")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(details).not.toBeVisible();
  });

  test("filters departments and keeps the accessible list on the same crew", async ({ page, request }) => {
    const { agents } = (await (await request.get("/api/crew/agents")).json()) as {
      agents: Array<{ id: string; departmentId: string | null; displayName: string }>;
    };
    const departmentId = agents.find((agent) => agent.departmentId)?.departmentId;
    expect(departmentId).toBeTruthy();
    const expected = agents.filter((agent) => agent.departmentId === departmentId);
    const office = page.getByTestId("crew-office");
    await office.getByLabel("Büro nach Abteilung filtern").selectOption(departmentId!);
    await expect(office.locator(".crew-office-person-button:enabled")).toHaveCount(expected.length);
    await office.getByRole("button", { name: "Liste", exact: true }).click();
    const list = office.getByRole("list", { name: "Crew und aktuelle Aufgaben" });
    await expect(list.getByRole("listitem")).toHaveCount(expected.length);
    for (const agent of expected) await expect(list.getByText(agent.displayName, { exact: true })).toBeVisible();
    await office.getByLabel("Büro nach Abteilung filtern").selectOption("");
    await expect(list.getByRole("listitem")).toHaveCount(agents.length);
  });
});
