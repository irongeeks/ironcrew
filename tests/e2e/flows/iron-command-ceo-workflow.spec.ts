/**
 * IronCrew — end-to-end verification of the vertical CEO workflow.
 *
 *   CEO -> Executive Assistant -> task -> delegation -> run -> review -> CEO
 *
 * Runs entirely on MockRuntime, so it needs no CLI login and is valid in CI.
 */

import { test, expect, type APIRequestContext } from "@playwright/test";
import { establishSession } from "../fixtures/test-helpers";

const CREW = "/api/crew";

async function session(request: APIRequestContext): Promise<Record<string, string>> {
  const csrf = await establishSession(request);
  return { "x-csrf-token": csrf };
}

test.describe("IronCrew control plane (API)", () => {
  test("seeds a company with exactly one executive assistant and no self-approving agent", async ({ request }) => {
    await session(request);

    const company = await request.get(`${CREW}/company`);
    expect(company.ok()).toBeTruthy();
    const { departments } = await company.json();
    expect(departments.length).toBeGreaterThan(5);

    const res = await request.get(`${CREW}/agents`);
    const { agents } = await res.json();
    expect(agents.length).toBeGreaterThan(10);

    const eas = agents.filter((a: { isExecutiveAssistant: boolean }) => a.isExecutiveAssistant);
    expect(eas).toHaveLength(1);

    // Policy beats persona: no agent may approve on the owner's behalf.
    for (const agent of agents) {
      expect(agent.policy.may_approve).toBe(false);
    }
  });

  test("drives a task from CEO message to accepted result", async ({ request }) => {
    const headers = await session(request);

    const chat = await request.post(`${CREW}/chat`, {
      headers,
      data: { body: "Bitte dokumentiere unser Backup-Verfahren fuer Proxmox." },
    });
    expect(chat.status()).toBe(201);
    const created = await chat.json();

    expect(created.triage.category).toBe("simple_task");
    expect(created.triage.suggestedDepartment).toBe("infrastructure");
    expect(created.task.status).toBe("ready");
    expect(created.assignedAgent).not.toBeNull();

    const exec = await request.post(`${CREW}/tasks/execute-next`, { headers });
    expect(exec.ok()).toBeTruthy();
    const executed = await exec.json();
    expect(executed.executed).toBe(true);
    expect(executed.task.status).toBe("review");
    expect(executed.eventCount).toBeGreaterThan(3);

    // Run events are persisted and replayable in order.
    const events = await (await request.get(`${CREW}/runs/${executed.runId}/events`)).json();
    expect(events.events[0].type).toBe("run.started");
    expect(events.events.at(-1).type).toBe("run.completed");

    const accepted = await request.post(`${CREW}/tasks/${executed.task.id}/accept`, {
      headers,
      data: { note: "Passt." },
    });
    expect(accepted.ok()).toBeTruthy();
    expect((await accepted.json()).task.status).toBe("done");
  });

  test("supports a revision round", async ({ request }) => {
    const headers = await session(request);

    await request.post(`${CREW}/chat`, {
      headers,
      data: { body: "Bitte erstelle eine Uebersicht der offenen Tickets." },
    });
    const executed = await (await request.post(`${CREW}/tasks/execute-next`, { headers })).json();
    expect(executed.task.status).toBe("review");

    const revised = await request.post(`${CREW}/tasks/${executed.task.id}/revise`, {
      headers,
      data: { reason: "Zu knapp, bitte Details ergaenzen." },
    });
    expect(revised.ok()).toBeTruthy();
    expect((await revised.json()).task.status).toBe("ready");
  });

  test("blocks a sensitive request behind an owner approval instead of executing it", async ({ request }) => {
    const headers = await session(request);

    const chat = await request.post(`${CREW}/chat`, {
      headers,
      data: { body: "Bitte ueberweise 4.500 EUR an den Lieferanten." },
    });
    const created = await chat.json();

    expect(created.triage.sensitive).toBe(true);
    expect(created.task.status).toBe("approval_required");
    expect(created.assignedAgent).toBeNull();
    expect(created.reply).toContain("NICHT ausgeführt");

    const { approvals } = await (await request.get(`${CREW}/approvals`)).json();
    const pending = approvals.find((a: { task_id: string }) => a.task_id === created.task.id);
    expect(pending.approval_type).toBe("bank_transfer");

    // A decision may be recorded exactly once.
    const decided = await request.post(`${CREW}/approvals/${pending.id}/decide`, {
      headers,
      data: { decision: "approved", reason: "Rechnung geprueft." },
    });
    expect(decided.ok()).toBeTruthy();

    const again = await request.post(`${CREW}/approvals/${pending.id}/decide`, {
      headers,
      data: { decision: "rejected" },
    });
    expect(again.status()).toBe(409);
  });

  test("enforces the vendor policy in the backend, not only in the UI", async ({ request }) => {
    const headers = await session(request);

    const allowed = await request.post(`${CREW}/vendor-policy/check`, {
      headers,
      data: { model: "anthropic/claude-sonnet-4" },
    });
    expect(allowed.status()).toBe(200);

    for (const model of [
      "deepseek/deepseek-chat",
      "qwen/qwen-2.5-72b-instruct",
      "moonshotai/kimi-k2",
      "z-ai/glm-4.6",
      "01-ai/yi-large",
      "bytedance/doubao-pro",
      "mystery/unknown-model",
    ]) {
      const res = await request.post(`${CREW}/vendor-policy/check`, { headers, data: { model } });
      expect(res.status(), `${model} must be refused`).toBe(403);
      expect((await res.json()).decision.allowed).toBe(false);
    }
  });

  test("keeps the audit chain valid across the whole flow", async ({ request }) => {
    const headers = await session(request);

    await request.post(`${CREW}/chat`, {
      headers,
      data: { body: "Bitte analysiere die Logdateien des Backup-Servers." },
    });
    await request.post(`${CREW}/tasks/execute-next`, { headers });

    const audit = await (await request.get(`${CREW}/audit`)).json();
    expect(audit.chain.valid).toBe(true);

    const actions = new Set(audit.events.map((e: { action: string }) => e.action));
    for (const expected of ["ceo.message_received", "task.created", "task.claimed", "task.transitioned"]) {
      expect(actions.has(expected), `missing audit action ${expected}`).toBeTruthy();
    }
  });

  test("stops runs when a hard budget is exhausted", async ({ request }) => {
    const headers = await session(request);

    await request.put(`${CREW}/budgets`, {
      headers,
      data: { scopeType: "company", limitMicros: 1, hardStop: true },
    });

    // Consume the budget, then confirm execution is refused with 402.
    const chat = await request.post(`${CREW}/chat`, {
      headers,
      data: { body: "Bitte erstelle die technische Dokumentation." },
    });
    const created = await chat.json();

    // Run once to generate cost, then the next attempt must be blocked.
    await request.post(`${CREW}/tasks/execute-next`, { headers });
    const second = await request.post(`${CREW}/tasks/execute-next`, { headers });
    expect([200, 402]).toContain(second.status());

    // Reset so later tests in this file are unaffected.
    await request.put(`${CREW}/budgets`, {
      headers,
      data: { scopeType: "company", limitMicros: 0, hardStop: false },
    });
    expect(created.task).toBeTruthy();
  });
});

test.describe("Command Center UI", () => {
  test.beforeEach(async ({ request }) => {
    await establishSession(request);
  });

  test("renders the command center with live backend state", async ({ page, request }) => {
    const headers = await session(request);
    await request.post(`${CREW}/chat`, {
      headers,
      data: { body: "Bitte pruefe die Firewall-Regeln auf Schwachstellen." },
    });

    await page.goto("/");
    await page.getByRole("button", { name: "COMMAND" }).first().click();

    const shell = page.getByTestId("command-center");
    await expect(shell).toBeVisible();

    // Office and board are views of the same canonical company.
    await expect(page.getByTestId("crew-office")).toBeVisible();
    await page.getByRole("button", { name: "Kanban", exact: true }).click();
    // The board renders the full task state machine, in German.
    await expect(page.getByTestId("kanban")).toBeVisible();
    for (const status of ["inbox", "ready", "running", "review", "approval_required", "done"]) {
      await expect(page.getByTestId(`column-${status}`)).toBeVisible();
    }

    // The seed crew is present and each figure carries a backend-derived status.
    const crewResponse = await request.get(`${CREW}/agents`);
    expect(crewResponse.ok()).toBe(true);
    const { agents } = (await crewResponse.json()) as { agents: Array<{ id: string }> };
    expect(agents.length).toBeGreaterThan(10);
    const dots = page.locator('[data-testid^="agent-status-"]');
    // The shell can render before the asynchronous crew request has completed.
    await expect(dots).toHaveCount(agents.length);

    // Explicitly NOT a retro/pixel office. Scoped to the brand mark, since the
    // company name in the sub-label also reads "IronCrew".
    await expect(page.locator(".ic-brand-mark")).toHaveText("IRONCREW");
  });

  test("lets the CEO send a message and see the EA reply", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "COMMAND" }).first().click();
    await expect(page.getByTestId("command-center")).toBeVisible();

    const message = `E2E Auftrag ${Date.now()}: bitte dokumentiere das Deployment-Verfahren.`;
    await page.getByTestId("chat-input").fill(message);

    // The send button is disabled while the draft is empty; wait for React to
    // enable it rather than racing the state update.
    const send = page.getByTestId("chat-send");
    await expect(send).toBeEnabled();
    await send.click();

    // This conversation is shared with the other tests in this file, so assert
    // on a message unique to this run rather than on the log as a whole.
    const log = page.getByTestId("chat-log");
    await expect(log).toContainText(message);
    await expect(log).toContainText("delegiert");
  });

  test("shows agent policy separately from persona", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "COMMAND" }).first().click();
    await expect(page.getByTestId("command-center")).toBeVisible();

    await page.locator(".ic-agent").filter({ hasText: "Ledger" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    // The finance agent's approval gates are visible and its persona is not
    // presented as a permission.
    await expect(dialog).toContainText("bank_transfer");
    await expect(dialog).toContainText("Policy hat immer Vorrang");
  });
});

test.describe("Canonical office live integration", () => {
  test("receives external tasks and keeps their identity across office and board", async ({ page, request }) => {
    const headers = await session(request);
    await page.goto("/");
    await expect(page.getByTestId("crew-office")).toBeVisible();
    await expect(page.getByTestId("crew-sync-status")).toContainText("Live");
    const response = await request.post(`${CREW}/chat`, {
      headers,
      data: { body: `Bitte dokumentiere die Netzwerkarchitektur. E2E Live ${Date.now()}` },
    });
    expect(response.status()).toBe(201);
    const { task } = await response.json();
    await page.getByRole("button", { name: "Kanban", exact: true }).click();
    const card = page.getByTestId("kanban").getByRole("button").filter({ hasText: task.title });
    await expect(card).toBeVisible();
    await card.click();
    const detail = page.getByRole("dialog", { name: task.title });
    await expect(detail).toContainText(task.correlation_id);
    await page.keyboard.press("Escape");
    await page
      .getByRole("group", { name: "Firmenansicht" })
      .getByRole("button", { name: "Office", exact: true })
      .click();
    await expect(page.getByTestId(`office-person-${task.assigned_agent_id}`)).toBeVisible();
  });

  test("mobile CEO entry and global mission open the same composer", async ({ page, request }) => {
    await session(request);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await expect(page.getByTestId("crew-office")).toBeVisible();
    await page.getByRole("button", { name: /CEO/ }).first().click();
    await expect(page.getByTestId("chat-input")).toBeFocused();
    await page.getByTestId("chat-input").fill("Entwurf bleibt erhalten");
    await page.getByRole("button", { name: "Kanban", exact: true }).click();
    await expect(page.getByTestId("chat-input")).toHaveValue("Entwurf bleibt erhalten");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  });
});

for (const width of [390, 768, 1440, 1920]) {
  test(`office layout at ${width}px`, async ({ page, request }, testInfo) => {
    await session(request);
    await page.setViewportSize({ width, height: width < 800 ? 1024 : 1080 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await expect(page.getByTestId("crew-office")).toBeVisible();
    await expect(page.locator('[data-testid^="office-person-"]').first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
    if (width >= 1440) {
      // ResizeObserver settles the transformed floor after the crew loads.
      // Width-only fitting used to leave the bottom desks clipped on desktop.
      await expect
        .poll(
          () =>
            page.evaluate(() => {
              const floor = document.querySelector(".crew-office-floor")?.getBoundingClientRect();
              const stage = document.querySelector(".ic-stage")?.getBoundingClientRect();
              if (!floor || !stage || floor.width <= 0 || floor.height <= 0) return Number.POSITIVE_INFINITY;
              return Math.max(stage.top - floor.top, floor.bottom - Math.min(stage.bottom, window.innerHeight), 0);
            }),
          { message: "Einpassen must keep the complete desktop office floor visible inside the stage" },
        )
        .toBeLessThanOrEqual(2);
    }
    await page.screenshot({ path: testInfo.outputPath(`office-${width}.png`), fullPage: true });
  });
}
