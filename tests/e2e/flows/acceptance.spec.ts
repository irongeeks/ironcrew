/** Product acceptance with actual MockRuntime runs. No CLI/account requests. */
import { expect, test } from "@playwright/test";
import { establishSession } from "../fixtures/test-helpers";

interface TaskDetail {
  task: { id: string; title: string; status: string; correlation_id: string; review_notes: string | null };
  runs: Array<{ id: string; status: string; correlation_id: string }>;
}

test("CEO requests a revision in the UI, receives a second run, accepts and reloads the persisted result", async ({
  page,
  request,
}, testInfo) => {
  const headers = { "x-csrf-token": await establishSession(request) };
  await page.goto("/");
  await expect(page.getByTestId("command-center")).toBeVisible();
  await expect(page.getByTestId("crew-sync-status")).toContainText("Live");
  const message = `Bitte dokumentiere das Backup-Verfahren. Abnahme ${testInfo.testId}`;
  const createdResponse = page.waitForResponse(
    (response) => response.url().endsWith("/api/crew/chat") && response.request().method() === "POST",
  );
  await page.getByTestId("chat-input").fill(message);
  await page.getByTestId("chat-send").click();
  const created = await createdResponse;
  expect(created.status()).toBe(201);
  const { task } = (await created.json()) as TaskDetail;
  const detail = async (): Promise<TaskDetail> => {
    const response = await request.get(`/api/crew/tasks/${task.id}`);
    expect(response.ok()).toBe(true);
    return response.json();
  };
  const drain = async () => {
    const response = await request.post("/api/crew/run-queue/drain", { headers, data: { limit: 50 } });
    expect(response.ok()).toBe(true);
  };
  await drain();
  await expect.poll(async () => (await detail()).task.status).toBe("review");
  const first = await detail();
  expect(first.runs).toHaveLength(1);
  const review = page.getByTestId(`review-${task.id}`);
  await expect(review).toBeVisible();
  const reason = "Bitte ergänze Restore-Schritte und überprüfbare Abnahmekriterien.";
  await review.getByRole("textbox", { name: `Revision für ${task.title}` }).fill(reason);
  const revisionResponse = page.waitForResponse(
    (response) => response.url().endsWith(`/tasks/${task.id}/revise`) && response.request().method() === "POST",
  );
  await review.getByRole("button", { name: "Revision", exact: true }).click();
  expect((await revisionResponse).ok()).toBe(true);
  await drain();
  await expect
    .poll(async () => {
      const current = await detail();
      return { status: current.task.status, runs: current.runs.length };
    })
    .toEqual({ status: "review", runs: 2 });
  const second = await detail();
  expect(second.task.review_notes).toBe(reason);
  expect(new Set(second.runs.map((run) => run.id)).size).toBe(2);
  for (const run of second.runs) {
    expect(run.status).toBe("completed");
    expect(run.correlation_id).toBe(task.correlation_id);
    const response = await request.get(`/api/crew/runs/${run.id}/events`);
    expect(response.ok()).toBe(true);
    const { events } = await response.json();
    expect(events[0].type).toBe("run.started");
    expect(events.at(-1).type).toBe("run.completed");
  }
  await expect(review).toBeVisible();
  const acceptanceResponse = page.waitForResponse(
    (response) => response.url().endsWith(`/tasks/${task.id}/accept`) && response.request().method() === "POST",
  );
  await review.getByRole("button", { name: "Abnehmen", exact: true }).click();
  expect((await acceptanceResponse).ok()).toBe(true);
  await page.reload();
  await expect(page.getByTestId("command-center")).toBeVisible();
  await expect(page.getByTestId("chat-log")).toContainText("Abgenommen");
  await page.getByRole("button", { name: "Kanban", exact: true }).click();
  const card = page.getByTestId("column-done").getByRole("button").filter({ hasText: task.title });
  await expect(card).toBeVisible();
  await card.click();
  await expect(page.getByRole("dialog", { name: task.title })).toContainText(task.correlation_id);
  expect((await detail()).runs).toHaveLength(2);
  const audit = await request.get("/api/crew/audit");
  expect((await audit.json()).chain.valid).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("ceo-revision-accepted.png"), fullPage: true });
});
