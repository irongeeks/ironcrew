import { test, expect } from "@playwright/test";
import { establishSession, expectOkJson } from "../fixtures/test-helpers";
import type { Department, Agent } from "../../../src/ironcrew/types";

test("opens individually furnished department rooms and returns to the building", async ({
  page,
  request,
}, testInfo) => {
  await establishSession(request);
  const { departments } = await expectOkJson<{ departments: Department[] }>(
    await request.get("/api/crew/company"),
    "Read actual company departments",
  );
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const office = page.getByTestId("crew-office");
  await expect(office).toBeVisible();
  expect(departments.length).toBeGreaterThan(10);
  for (const department of departments) {
    await expect(office.getByTestId(`office-room-${department.id}`)).toHaveCount(1);
    await expect(office.getByTestId(`office-room-focus-${department.id}`)).toHaveAccessibleName(
      `Raum öffnen: ${department.name}`,
    );
  }
  await expect(office.getByTestId("office-room-focus-lounge")).toHaveCount(1);
  await office.screenshot({ path: testInfo.outputPath("living-building-overview.png") });

  const department = departments.find((item) => item.key === "engineering") ?? departments[0];
  await office.getByTestId(`office-room-focus-${department.id}`).click();
  await expect(office.getByRole("heading", { name: department.name, exact: true })).toBeVisible();
  await expect(office.locator(".crew-office-canvas-space")).toHaveAttribute("data-focused-room", department.id);
  await office.screenshot({ path: testInfo.outputPath("living-building-department.png") });
  await office.getByRole("button", { name: "Gebäudeübersicht", exact: true }).click();
  await expect(office.locator(".crew-office-canvas-space")).not.toHaveAttribute("data-focused-room");

  await page.setViewportSize({ width: 390, height: 844 });
  await office.getByRole("button", { name: "Liste", exact: true }).click();
  const roster = office.getByRole("list", { name: "Crew und aktuelle Aufgaben", exact: true });
  await expect(roster).toBeVisible();
  const { agents } = await expectOkJson<{ agents: Agent[] }>(await request.get("/api/crew/agents"), "Read crew");
  await expect(roster.getByRole("listitem")).toHaveCount(agents.length);
  await roster.getByRole("listitem").last().scrollIntoViewIfNeeded();
  await expect(roster.getByRole("listitem").last()).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("living-building-mobile-list.png") });
});

test("walks idle figures through the building and freezes ambient motion on request", async ({ page, request }) => {
  await establishSession(request);
  await page.clock.install();
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const writes: string[] = [];
  page.on("request", (req) => {
    if (
      new URL(req.url()).pathname.startsWith("/api/crew/") &&
      ["POST", "PUT", "PATCH", "DELETE"].includes(req.method())
    )
      writes.push(`${req.method()} ${new URL(req.url()).pathname}`);
  });
  await page.goto("/");
  const office = page.getByTestId("crew-office");
  const { agents } = await expectOkJson<{ agents: Agent[] }>(await request.get("/api/crew/agents"), "Read actual crew");
  await expect(office.locator('[data-testid^="office-person-"]')).toHaveCount(agents.length);
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  // These are animation-clock samples, not sleeps substituting for API events.
  const walkers = office.locator('[data-motion="walking"]');
  for (let sample = 0; sample < 8 && (await walkers.count()) === 0; sample++) await page.clock.runFor(5000);
  await expect(walkers.first()).toBeAttached();
  const id = (await walkers.first().getAttribute("data-testid"))!;
  const person = office.getByTestId(id);
  const position = () =>
    person.evaluate((node) => [
      (node as HTMLElement).style.getPropertyValue("--office-x"),
      (node as HTMLElement).style.getPropertyValue("--office-y"),
    ]);
  const initial = await position();
  await page.clock.runFor(1000);
  expect(await position()).not.toEqual(initial);

  await office.getByRole("button", { name: "Bürobewegung pausieren", exact: true }).click();
  await expect(person).toHaveAttribute("data-motion-paused", "true");
  const paused = await position();
  await page.clock.runFor(10000);
  expect(await position()).toEqual(paused);
  await office.getByRole("button", { name: "Bürobewegung fortsetzen", exact: true }).click();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(person).toHaveAttribute("data-motion-paused", "true");
  const reduced = await position();
  await page.clock.runFor(10000);
  expect(await position()).toEqual(reduced);
  expect(writes, "Ambient animation must not start work, meetings, messages or model calls").toEqual([]);
});
