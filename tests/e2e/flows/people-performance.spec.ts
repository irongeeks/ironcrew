import { test, expect, type APIRequestContext } from "@playwright/test";
import { establishSession, expectOkJson } from "../fixtures/test-helpers";
import type { Agent, Department } from "../../../src/ironcrew/types";
import { CAREER_FALLBACK_REVIEWER_ROLES } from "../../../src/shared/career";
import type { CareerSnapshot, RatingAggregate } from "../../../src/shared/career";
import type { RoutingSnapshot } from "../../../src/shared/routing-profiles";

const endpoint = "/api/crew/people";
const cleanups = new Map<string, (request: APIRequestContext) => Promise<void>>();
test.afterEach(async ({ request }, testInfo) => {
  // A separate teardown budget restores configuration even when a UI step times out.
  const cleanup = cleanups.get(testInfo.testId);
  cleanups.delete(testInfo.testId);
  await cleanup?.(request);
});
const levels = { junior: "Junior", senior: "Senior", lead: "Lead" } as const;
const snapshot = async (request: APIRequestContext) =>
  expectOkJson<CareerSnapshot>(await request.get(endpoint), "Read canonical career and review data");
const ratingText = (rating: RatingAggregate | undefined) =>
  rating?.count
    ? `${rating.mean.toLocaleString("de-DE", { maximumFractionDigits: 2 })} / 5 · ${rating.count} Bewertungen`
    : "– Unbewertet";

test("opens canonical employee performance, filters real review data and reopens the unchanged configuration", async ({
  page,
  request,
}, testInfo) => {
  await establishSession(request);
  const before = await snapshot(request);
  const { agents } = await expectOkJson<{ agents: Agent[] }>(await request.get("/api/crew/agents"), "Read employees");
  const routing = await expectOkJson<RoutingSnapshot>(
    await request.get("/api/crew/routing"),
    "Read existing model profiles",
  );
  const agent = agents.find((item) => item.key === "cto") ?? agents[0];
  expect(agent, "The canonical seed crew must contain an employee").toBeDefined();
  const profile = before.profiles.find((item) => item.agentId === agent.id);
  expect(profile, "The employee must have a canonical career profile").toBeDefined();
  const rating = before.aggregates.agents.find((item) => item.key === agent.id);
  const binding = routing.bindings.find((item) => item.agentId === agent.id);
  const route = routing.config.profiles.find((item) => item.key === binding?.profileKey);
  const routeLabel = route ? `${route.label} (${route.key})` : (binding?.profileKey ?? "Keine explizite Bindung");

  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.getByTestId(`office-person-${agent.id}`).locator(".crew-office-person-button").click();
  const summary = page.getByRole("region", { name: "Laufbahn und Aufgabenleistung", exact: true });
  await expect(summary).toBeVisible();
  await expect(summary.getByText(levels[profile!.level], { exact: true })).toBeVisible();
  await expect(summary.getByText(ratingText(rating), { exact: true })).toBeVisible();
  await expect(summary.getByText(routeLabel, { exact: true })).toBeVisible();
  await summary.getByText("Letzte Aufgabenbewertungen", { exact: true }).click();
  const recent = before.reviews.filter((item) => item.agentId === agent.id).slice(0, 5);
  await expect(summary.locator(".people-history article")).toHaveCount(recent.length);
  if (!recent.length) {
    await expect(summary).toContainText(
      "Ein abgeschlossener Arbeits-Run und ein unabhängiger Lead-Review sind erforderlich.",
    );
  }
  await summary.screenshot({ path: testInfo.outputPath("people-employee-profile.png") });
  await summary
    .getByRole("button", { name: "Teamsteuerung und gesamten Bewertungsverlauf öffnen", exact: true })
    .click();

  const panel = page.getByRole("region", { name: "Team und Leistung", exact: true });
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute("aria-busy", "false");
  const roster = panel
    .locator("table")
    .filter({ has: page.getByRole("columnheader", { name: "Mitarbeiter / Fachrolle", exact: true }) });
  const row = roster.getByTestId(`people-agent-${agent.id}`);
  await expect(row.getByRole("rowheader")).toContainText(agent.displayName);
  await expect(row).toHaveCount(1);
  await expect(row.getByRole("cell", { name: levels[profile!.level], exact: true })).toBeVisible();
  await expect(row.getByRole("cell", { name: routeLabel, exact: true })).toBeVisible();
  await expect(row.getByRole("cell", { name: ratingText(rating), exact: true })).toBeVisible();
  await expect(panel).toContainText("Durchschnitt und Anzahl sind keine objektive Modellgüte");
  await expect(
    panel.getByRole("checkbox", { name: "Lead-Delegation und Aufgabenbewertung aktivieren", exact: true }),
  ).toBeChecked({ checked: before.config.enabled });

  // This is a deliberately absent filter value, never a seeded model or an invented score.
  const absentModel = "e2e-filter-with-no-recorded-work-model";
  expect(before.reviews.some((review) => review.model === absentModel)).toBe(false);
  await panel.getByRole("combobox", { name: "Schwierigkeit", exact: true }).selectOption("complex");
  await panel.getByRole("textbox", { name: "Modellname (exakt)", exact: true }).fill(absentModel);
  const filteredResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === endpoint &&
      url.searchParams.get("difficulty") === "complex" &&
      url.searchParams.get("model") === absentModel
    );
  });
  await panel.getByRole("button", { name: "Filter anwenden", exact: true }).click();
  const filtered = await expectOkJson<CareerSnapshot>(await filteredResponse, "Read filtered review data");
  expect(filtered.reviews).toEqual([]);
  expect(filtered.aggregates).toEqual({ agents: [], models: [] });
  expect(filtered.config).toEqual(before.config);
  await expect(panel).toHaveAttribute("aria-busy", "false");
  await expect(panel.locator(".people-history article")).toHaveCount(0);
  await expect(panel.locator(".people-distribution")).toHaveCount(0);
  await expect(row.getByRole("cell", { name: "– Unbewertet", exact: true })).toBeVisible();
  await panel.locator("header").screenshot({ path: testInfo.outputPath("people-review-context.png") });

  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await page.reload();
  await page.getByTestId("open-people").click();
  await expect(panel).toHaveAttribute("aria-busy", "false");
  await expect(panel.getByRole("combobox", { name: "Schwierigkeit", exact: true })).toHaveValue("");
  await expect(panel.getByRole("textbox", { name: "Modellname (exakt)", exact: true })).toHaveValue("");
  await expect(row.getByRole("cell", { name: ratingText(rating), exact: true })).toBeVisible();
  expect((await snapshot(request)).config).toEqual(before.config);
  const afterAgent = (
    await expectOkJson<{ agents: Agent[] }>(await request.get("/api/crew/agents"), "Read unchanged employee")
  ).agents.find((item) => item.id === agent.id)!;
  expect(afterAgent.policy).toEqual(agent.policy);
  expect(afterAgent.professionalRole).toBe(agent.professionalRole);
  expect((await snapshot(request)).profiles).toEqual(before.profiles);
  await roster.screenshot({ path: testInfo.outputPath("people-canonical-roster-reopened.png") });
});

test("saves an inactive department reviewer, retains it after reload and rejects a stale configuration", async ({
  page,
  request,
}, testInfo) => {
  const csrf = await establishSession(request);
  const headers = { "x-csrf-token": csrf };
  const before = await snapshot(request);
  const { departments } = await expectOkJson<{ departments: Department[] }>(
    await request.get("/api/crew/company"),
    "Read canonical departments",
  );
  const { agents } = await expectOkJson<{ agents: Agent[] }>(
    await request.get("/api/crew/agents"),
    "Read reviewer roles",
  );
  const department = departments.find(
    (item) => !before.config.departments.find((policy) => policy.departmentId === item.id)?.enabled,
  );
  expect(department, "An inactive seed department is required so this test starts no delegation").toBeDefined();
  const original = before.config.departments.find((policy) => policy.departmentId === department!.id);
  const fallbackRoles = new Set<string>(CAREER_FALLBACK_REVIEWER_ROLES);
  const reviewer = agents.find(
    (agent) => fallbackRoles.has(agent.professionalRole) && agent.id !== original?.leadAgentId,
  );
  expect(reviewer, "The seed crew must contain an independent QA/COO reviewer").toBeDefined();
  const target = original?.fallbackReviewerAgentId ? "" : reviewer!.id;
  cleanups.set(testInfo.testId, async (request) => {
    const current = await snapshot(request);
    await expectOkJson(
      await request.put(`${endpoint}/config`, {
        headers,
        data: {
          baseRevision: current.config.revision,
          enabled: before.config.enabled,
          departments: before.config.departments,
        },
      }),
      "Restore original department policy",
    );
    const restored = await snapshot(request);
    expect(restored.config.enabled).toBe(before.config.enabled);
    expect(restored.config.departments).toEqual(before.config.departments);
    expect(restored.profiles).toEqual(before.profiles);
  });
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.getByTestId("open-people").click();
  const panel = page.getByRole("region", { name: "Team und Leistung", exact: true });
  await expect(panel).toHaveAttribute("aria-busy", "false");
  const group = panel.getByRole("group", { name: department!.name, exact: true });
  await expect(group.getByRole("checkbox", { name: "Delegation für diese Abteilung", exact: true })).not.toBeChecked();
  const fallback = group.getByRole("combobox", { name: "Unabhängiger Ersatzreviewer", exact: true });
  await fallback.selectOption(target);
  const savedResponse = page.waitForResponse(
    (response) => new URL(response.url()).pathname === `${endpoint}/config` && response.request().method() === "PUT",
  );
  await panel.getByRole("button", { name: "Abteilungssteuerung speichern", exact: true }).click();
  await expectOkJson(await savedResponse, "Save inactive department reviewer");
  await expect(panel.getByRole("status").filter({ hasText: "Abteilungssteuerung gespeichert." })).toBeVisible();
  await expect(panel).toHaveAttribute("aria-busy", "false");
  const saved = await snapshot(request);
  expect(saved.config.revision).toBe(before.config.revision + 1);
  expect(saved.config.enabled).toBe(before.config.enabled);
  expect(saved.config.departments.find((policy) => policy.departmentId === department!.id)).toEqual({
    departmentId: department!.id,
    enabled: false,
    leadAgentId: original?.leadAgentId ?? null,
    fallbackReviewerAgentId: target || null,
  });
  expect(saved.profiles).toEqual(before.profiles);
  expect(saved.reviews).toEqual(before.reviews);
  const stale = await request.put(`${endpoint}/config`, {
    headers,
    data: {
      baseRevision: before.config.revision,
      enabled: before.config.enabled,
      departments: before.config.departments,
    },
  });
  expect(stale.status()).toBe(409);
  expect((await stale.json()).error).toBe("stale_revision");
  expect((await snapshot(request)).config).toEqual(saved.config);
  await page.reload();
  await page.getByTestId("open-people").click();
  await expect(panel).toHaveAttribute("aria-busy", "false");
  await expect(fallback).toHaveValue(target);
  await expect(group.getByRole("checkbox", { name: "Delegation für diese Abteilung", exact: true })).not.toBeChecked();
  const afterAgents = (
    await expectOkJson<{ agents: Agent[] }>(
      await request.get("/api/crew/agents"),
      "Check unchanged professional roles and permissions",
    )
  ).agents;
  for (const agent of agents) {
    const after = afterAgents.find((item) => item.id === agent.id)!;
    expect(after.policy).toEqual(agent.policy);
    expect(after.professionalRole).toBe(agent.professionalRole);
  }
  await group.screenshot({ path: testInfo.outputPath("people-inactive-reviewer-persisted.png") });
});

test("refuses browser-supplied self-ratings and preserves canonical review history", async ({ request }) => {
  const csrf = await establishSession(request);
  const before = await snapshot(request);
  const agent = before.profiles[0];
  expect(agent).toBeDefined();
  // Reviews are produced from completed work/reviewer runs, not a browser score endpoint.
  const response = await request.post(`${endpoint}/reviews`, {
    headers: { "x-csrf-token": csrf },
    data: {
      agentId: agent.agentId,
      reviewerAgentId: agent.agentId,
      score: 5,
      rationale: "E2E: reject direct self-rating",
    },
  });
  expect(response.status()).toBe(404);
  const after = await snapshot(request);
  expect(after.reviews).toEqual(before.reviews);
  expect(after.aggregates).toEqual(before.aggregates);
  expect(after.profiles).toEqual(before.profiles);
  expect(after.config).toEqual(before.config);
});
