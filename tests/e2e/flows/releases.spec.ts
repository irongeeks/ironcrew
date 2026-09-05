import { test, expect } from "@playwright/test";
import { establishSession, navigateTo } from "../fixtures/test-helpers";

test("release settings show pinned update guidance and recover from a failed check", async ({
  page,
  request,
}, testInfo) => {
  const csrf = await establishSession(request);
  await request.put("/api/settings", { data: { language: "de" }, headers: { "x-csrf-token": csrf } });
  let unavailable = false;
  await page.route("**/api/update-status*", async (route) => {
    await route.fulfill({
      json: {
        ok: true,
        current_version: "2.8.0",
        latest_version: unavailable ? null : "2.8.1",
        latest_tag: unavailable ? null : "v2.8.1",
        update_available: !unavailable,
        enabled: true,
        checked_at: Date.UTC(2026, 8, 5),
        channel: "stable",
        repo: "irongeeks/ironcrew",
        install_type: "native",
        self_update_supported: false,
        error: unavailable ? "release_check_unavailable" : null,
        discovery: unavailable ? "unavailable" : "available",
        release_url: unavailable ? null : "https://github.com/irongeeks/ironcrew/releases/tag/v2.8.1",
        instructions: {
          command: unavailable ? null : "node scripts/ironcrew-update.mjs --to v2.8.1 --check",
          steps: ["Dienste stoppen, Sicherung erstellen und die ausgewählte Version installieren."],
          documentation_url: "https://github.com/irongeeks/ironcrew/blob/main/docs/RELEASES.md",
        },
      },
    });
  });
  await page.goto("/");
  await navigateTo(page, "settings");
  const updates = page.getByRole("region", { name: "Version und Updates" });
  await expect(updates.getByText("v2.8.0", { exact: true })).toBeVisible();
  await expect(updates.getByText("Ein neueres Stable Release ist verfügbar.")).toBeVisible();
  await expect(updates.locator("code")).toHaveText("node scripts/ironcrew-update.mjs --to v2.8.1 --check");
  await expect(updates.getByRole("link", { name: "Release-Hinweise öffnen" })).toHaveAttribute(
    "href",
    "https://github.com/irongeeks/ironcrew/releases/tag/v2.8.1",
  );
  await updates.screenshot({ path: testInfo.outputPath("release-update-settings.png") });
  unavailable = true;
  await updates.getByRole("button", { name: "Stable Release prüfen" }).click();
  await expect(updates.getByText(/Release-Prüfung fehlgeschlagen/)).toBeVisible();
  await expect(updates.locator("code")).toHaveCount(0);
  unavailable = false;
  await updates.getByRole("button", { name: "Stable Release prüfen" }).click();
  await expect(updates.getByText("Ein neueres Stable Release ist verfügbar.")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(updates.getByRole("button", { name: "Stable Release prüfen" })).toBeVisible();
  await updates.screenshot({ path: testInfo.outputPath("release-update-mobile.png") });
  await request.put("/api/settings", { data: { language: "en" }, headers: { "x-csrf-token": csrf } });
});
