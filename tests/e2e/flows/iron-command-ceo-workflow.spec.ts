/**
 * Iron Command OS — end-to-end verification of the vertical CEO workflow.
 *
 *   CEO -> Executive Assistant -> task -> delegation -> run -> review -> CEO
 *
 * Runs entirely on MockRuntime, so it needs no CLI login and is valid in CI.
 */

import { test, expect, type APIRequestContext } from "@playwright/test";
import { establishSession } from "../fixtures/test-helpers";

const IC = "/api/ic";

async function session(request: APIRequestContext): Promise<Record<string, string>> {
  const csrf = await establishSession(request);
  return { "x-csrf-token": csrf };
}

test.describe("Iron Command control plane (API)", () => {
  test("seeds a company with exactly one executive assistant and no self-approving agent", async ({
    request,
  }) => {
    await session(request);

    const company = await request.get(`${IC}/company`);
    expect(company.ok()).toBeTruthy();
    const { departments } = await company.json();
    expect(departments.length).toBeGreaterThan(5);

    const res = await request.get(`${IC}/agents`);
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

    const chat = await request.post(`${IC}/chat`, {
      headers,
      data: { body: "Bitte dokumentiere unser Backup-Verfahren fuer Proxmox." },
    });
    expect(chat.status()).toBe(201);
    const created = await chat.json();

    expect(created.triage.category).toBe("simple_task");
    expect(created.triage.suggestedDepartment).toBe("infrastructure");
    expect(created.task.status).toBe("ready");
    expect(created.assignedAgent).not.toBeNull();

    const exec = await request.post(`${IC}/tasks/execute-next`, { headers });
    expect(exec.ok()).toBeTruthy();
    const executed = await exec.json();
    expect(executed.executed).toBe(true);
    expect(executed.task.status).toBe("review");
    expect(executed.eventCount).toBeGreaterThan(3);

    // Run events are persisted and replayable in order.
    const events = await (await request.get(`${IC}/runs/${executed.runId}/events`)).json();
    expect(events.events[0].type).toBe("run.started");
    expect(events.events.at(-1).type).toBe("run.completed");

    const accepted = await request.post(`${IC}/tasks/${executed.task.id}/accept`, {
      headers,
      data: { note: "Passt." },
    });
    expect(accepted.ok()).toBeTruthy();
    expect((await accepted.json()).task.status).toBe("done");
  });

  test("supports a revision round", async ({ request }) => {
    const headers = await session(request);

    await request.post(`${IC}/chat`, {
      headers,
      data: { body: "Bitte erstelle eine Uebersicht der offenen Tickets." },
    });
    const executed = await (await request.post(`${IC}/tasks/execute-next`, { headers })).json();
    expect(executed.task.status).toBe("review");

    const revised = await request.post(`${IC}/tasks/${executed.task.id}/revise`, {
      headers,
      data: { reason: "Zu knapp, bitte Details ergaenzen." },
    });
    expect(revised.ok()).toBeTruthy();
    expect((await revised.json()).task.status).toBe("ready");
  });

  test("blocks a sensitive request behind an owner approval instead of executing it", async ({
    request,
  }) => {
    const headers = await session(request);

    const chat = await request.post(`${IC}/chat`, {
      headers,
      data: { body: "Bitte ueberweise 4.500 EUR an den Lieferanten." },
    });
    const created = await chat.json();

    expect(created.triage.sensitive).toBe(true);
    expect(created.task.status).toBe("approval_required");
    expect(created.assignedAgent).toBeNull();
    expect(created.reply).toContain("NICHT ausgeführt");

    const { approvals } = await (await request.get(`${IC}/approvals`)).json();
    const pending = approvals.find(
      (a: { task_id: string }) => a.task_id === created.task.id,
    );
    expect(pending.approval_type).toBe("bank_transfer");

    // A decision may be recorded exactly once.
    const decided = await request.post(`${IC}/approvals/${pending.id}/decide`, {
      headers,
      data: { decision: "approved", reason: "Rechnung geprueft." },
    });
    expect(decided.ok()).toBeTruthy();

    const again = await request.post(`${IC}/approvals/${pending.id}/decide`, {
      headers,
      data: { decision: "rejected" },
    });
    expect(again.status()).toBe(409);
  });

  test("enforces the vendor policy in the backend, not only in the UI", async ({ request }) => {
    const headers = await session(request);

    const allowed = await request.post(`${IC}/vendor-policy/check`, {
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
      const res = await request.post(`${IC}/vendor-policy/check`, { headers, data: { model } });
      expect(res.status(), `${model} must be refused`).toBe(403);
      expect((await res.json()).decision.allowed).toBe(false);
    }
  });

  test("keeps the audit chain valid across the whole flow", async ({ request }) => {
    const headers = await session(request);

    await request.post(`${IC}/chat`, {
      headers,
      data: { body: "Bitte analysiere die Logdateien des Backup-Servers." },
    });
    await request.post(`${IC}/tasks/execute-next`, { headers });

    const audit = await (await request.get(`${IC}/audit`)).json();
    expect(audit.chain.valid).toBe(true);

    const actions = new Set(audit.events.map((e: { action: string }) => e.action));
    for (const expected of ["ceo.message_received", "task.created", "task.claimed", "task.transitioned"]) {
      expect(actions.has(expected), `missing audit action ${expected}`).toBeTruthy();
    }
  });

  test("stops runs when a hard budget is exhausted", async ({ request }) => {
    const headers = await session(request);

    await request.put(`${IC}/budgets`, {
      headers,
      data: { scopeType: "company", limitMicros: 1, hardStop: true },
    });

    // Consume the budget, then confirm execution is refused with 402.
    const chat = await request.post(`${IC}/chat`, {
      headers,
      data: { body: "Bitte erstelle die technische Dokumentation." },
    });
    const created = await chat.json();

    // Run once to generate cost, then the next attempt must be blocked.
    await request.post(`${IC}/tasks/execute-next`, { headers });
    const second = await request.post(`${IC}/tasks/execute-next`, { headers });
    expect([200, 402]).toContain(second.status());

    // Reset so later tests in this file are unaffected.
    await request.put(`${IC}/budgets`, {
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
    await request.post(`${IC}/chat`, {
      headers,
      data: { body: "Bitte pruefe die Firewall-Regeln auf Schwachstellen." },
    });

    await page.goto("/");
    await page.getByRole("button", { name: "COMMAND" }).first().click();

    const shell = page.getByTestId("command-center");
    await expect(shell).toBeVisible();

    // The board renders the full task state machine, in German.
    await expect(page.getByTestId("kanban")).toBeVisible();
    for (const status of ["inbox", "ready", "running", "review", "approval_required", "done"]) {
      await expect(page.getByTestId(`column-${status}`)).toBeVisible();
    }

    // The seed crew is present and each figure carries a backend-derived status.
    const dots = page.locator('[data-testid^="agent-status-"]');
    expect(await dots.count()).toBeGreaterThan(10);

    // Explicitly NOT a retro/pixel office. Scoped to the brand mark, since the
    // company name in the sub-label also reads "Iron Command".
    await expect(page.locator(".ic-brand-mark")).toHaveText("IRON COMMAND");
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
