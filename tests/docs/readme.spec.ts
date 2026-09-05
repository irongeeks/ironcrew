import { test, expect } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { establishSession, expectOkJson, navigateTo } from "../e2e/fixtures/test-helpers";
import type { Agent, Department } from "../../src/ironcrew/types";

test("captures the documented company views from an isolated test installation", async ({ page, request }, info) => {
  const csrf = await establishSession(request);
  const headers = { "x-csrf-token": csrf };
  await expectOkJson(await request.put("/api/settings", { headers, data: { language: "de" } }), "Set language");
  const { agents } = await expectOkJson<{ agents: Agent[] }>(await request.get("/api/crew/agents"), "Read seed crew");
  const { departments } = await expectOkJson<{ departments: Department[] }>(
    await request.get("/api/crew/company"),
    "Read departments",
  );
  // Ordinary test task, created through the same API as the CEO composer.
  // No ratings, provider health or successful external runs are fabricated.
  await expectOkJson(
    await request.post("/api/crew/chat", {
      headers,
      data: { body: "Bitte dokumentiere unser Backup-Verfahren für Proxmox. Testauftrag für die Dokumentation." },
    }),
    "Create documented test task",
  );
  await page.goto("/");
  const office = page.getByTestId("crew-office");
  await expect(office).toBeVisible();
  await expect(office.locator('[data-testid^="office-person-"]')).toHaveCount(agents.length);
  await expect(page.getByTestId("crew-sync-status")).toContainText("Live");
  await expect(page.getByTestId("chat-log")).toContainText("Testauftrag für die Dokumentation");
  await page.screenshot({ path: info.outputPath("ironcrew-office.png") });

  const department = departments.find((item) => item.key === "engineering")!;
  expect(department).toBeDefined();
  await office.getByTestId(`office-room-focus-${department.id}`).click();
  await expect(office.getByRole("heading", { name: department.name, exact: true })).toBeVisible();
  await office.screenshot({ path: info.outputPath("ironcrew-department.png") });
  await office.getByRole("button", { name: "Gebäudeübersicht", exact: true }).click();

  // The complete roster is taller than the normal viewport. Give its scroll
  // container enough real viewport space rather than capturing clipped rows.
  await page.setViewportSize({ width: 1920, height: 2000 });
  await page.getByTestId("open-people").click();
  const people = page.getByRole("region", { name: "Team und Leistung", exact: true });
  await expect(people).toHaveAttribute("aria-busy", "false");
  const roster = people.locator("table").filter({
    has: page.getByRole("columnheader", { name: "Mitarbeiter / Fachrolle", exact: true }),
  });
  await expect(roster.locator("tbody tr")).toHaveCount(agents.length);
  await expect(roster).toContainText("Unbewertet");
  await roster.scrollIntoViewIfNeeded();
  await expect(roster.locator("tbody tr").first()).toBeInViewport();
  await expect(roster.locator("tbody tr").last()).toBeInViewport();
  await roster.screenshot({ path: info.outputPath("ironcrew-crew.png") });
  await page.keyboard.press("Escape");
  await expect(people).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await office.getByRole("button", { name: "Liste", exact: true }).click();
  await expect(office.getByRole("list", { name: "Crew und aktuelle Aufgaben", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: info.outputPath("ironcrew-mobile.png") });

  await page.setViewportSize({ width: 1440, height: 1080 });
  await navigateTo(page, "settings");
  const updates = page.getByRole("region", { name: "Version und Updates" });
  const { version } = JSON.parse(await readFile("package.json", "utf8")) as { version: string };
  await expect(updates.getByText(`v${version}`, { exact: true })).toBeVisible();
  await expect(updates).toContainText("Release-Prüfung ist auf diesem Server deaktiviert.");
  await updates.screenshot({ path: info.outputPath("ironcrew-updates.png") });
  await writeFile(
    info.outputPath("screenshots.json"),
    JSON.stringify(
      {
        version,
        commit: process.env.GITHUB_SHA ?? "local",
        capturedAt: new Date().toISOString(),
        source: "tests/docs/readme.spec.ts",
        data: "Fresh isolated E2E database, original seed crew, one explicit documentation test task; no provider run.",
        updateCheck: "Disabled; no simulated release availability.",
        files: [
          "ironcrew-office.png",
          "ironcrew-department.png",
          "ironcrew-crew.png",
          "ironcrew-mobile.png",
          "ironcrew-updates.png",
        ],
      },
      null,
      2,
    ) + "\n",
  );
});
