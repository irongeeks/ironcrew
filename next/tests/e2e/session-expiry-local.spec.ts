import { test, expect, type Request } from "@playwright/test";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((ready) => {
    resolve = ready;
  });
  return { promise, resolve };
}

for (const trigger of ["read", "logout", "delayed logout"] as const) {
  test(`expired local session returns to login after ${trigger} and permits a fresh session`, async ({
    page,
    context,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const reads = new Set<Request>();
    let lastRead = Date.now();
    page.on("request", (request) => {
      if (request.url().includes("/api/v1/") && request.resourceType() !== "eventsource") {
        reads.add(request);
        lastRead = Date.now();
      }
    });
    const finished = (request: Request) => {
      if (reads.delete(request)) lastRead = Date.now();
    };
    page.on("requestfinished", finished);
    page.on("requestfailed", finished);
    await page.goto("/orders");
    await page.getByLabel("Passwort", { exact: true }).fill("local-e2e-fixture-password");
    await page.getByRole("button", { name: "Anmelden", exact: true }).click();
    await expect(page.getByRole("button", { name: "Neuer Auftrag", exact: true })).toBeVisible();
    // Finish initial authenticated reads before expiring the cookie; otherwise one of
    // those reads can correctly return to login before the logout button is reached.
    // The initial SSE event schedules another refresh after 80ms; SSE itself stays open.
    await expect.poll(() => reads.size === 0 && Date.now() - lastRead > 200).toBe(true);
    const delayed = trigger === "delayed logout";
    const logoutReady = gate();
    const releaseLogout = gate();
    if (delayed) {
      await page.route("**/api/v1/session", async (route) => {
        if (route.request().method() !== "DELETE") return route.continue();
        // Preserve the real server result; only its delivery is delayed.
        const response = await route.fetch();
        expect(response.status()).toBe(401);
        logoutReady.resolve();
        await releaseLogout.promise;
        await route.fulfill({ response });
      });
    }
    try {
      if (trigger !== "read") await page.locator("summary").filter({ hasText: "CEO" }).click();
      // Browsers remove the session cookie at its expiry. Keep the current page mounted.
      await context.clearCookies();
      if (trigger !== "read") {
        await page.getByRole("button", { name: "Abmelden", exact: true }).click();
        if (delayed) {
          await logoutReady.promise;
          // A separate authenticated read observes expiry before the old logout arrives.
          await page.evaluate(() => window.dispatchEvent(new Event("ironcrew:notifications-refresh")));
        }
      } else {
        await page
          .getByRole("navigation", { name: "Hauptnavigation" })
          .getByRole("link", { name: "Crew", exact: true })
          .click();
      }
      await expect(page.getByRole("button", { name: "Anmelden", exact: true })).toBeVisible();
      await page.getByLabel("Passwort", { exact: true }).fill("local-e2e-fixture-password");
      await page.getByRole("button", { name: "Anmelden", exact: true }).click();
      await expect(page.getByRole("navigation", { name: "Hauptnavigation" })).toBeVisible();
      expect((await (await page.request.get("/api/v1/session")).json()).authenticated).toBe(true);
      if (delayed) {
        const currentSession = page.waitForResponse(
          (response) => response.url().endsWith("/api/v1/session") && response.request().method() === "GET",
        );
        releaseLogout.resolve();
        expect((await (await currentSession).json()).authenticated).toBe(true);
        await expect(page.getByRole("navigation", { name: "Hauptnavigation" })).toBeVisible();
        await expect(page.getByRole("button", { name: "Anmelden", exact: true })).not.toBeVisible();
      }
      expect(errors).toEqual([]);
    } finally {
      releaseLogout.resolve();
    }
  });
}
