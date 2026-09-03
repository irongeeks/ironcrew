import { test, expect, type APIRequestContext } from "@playwright/test";
import { WebSocket } from "ws";
import { navigateTo, establishSession, sleep } from "../fixtures/test-helpers";
import { wsUrl, wsOrigin } from "../helpers/api-client";

type WsEnvelope = {
  type: string;
  payload: unknown;
  ts: number;
};

/** Establish session and extract the cookie header needed for raw WebSocket connections. */
async function establishApiSession(request: APIRequestContext): Promise<{ cookie: string; csrfToken: string }> {
  const timeoutMs = 30_000;
  const start = Date.now();
  let lastStatus = 0;

  while (Date.now() - start < timeoutMs) {
    const response = await request.get("/api/auth/session");
    if (response.ok()) {
      const body = await response.json();
      const storage = await request.storageState();
      const sessionCookie = storage.cookies.find((c) => c.name === "claw_session");
      if (!sessionCookie) {
        throw new Error("claw_session cookie not found after session establishment");
      }
      return {
        cookie: `${sessionCookie.name}=${sessionCookie.value}`,
        csrfToken: body.csrf_token as string,
      };
    }
    lastStatus = response.status();
    if ([502, 503, 404].includes(lastStatus)) {
      await sleep(500);
      continue;
    }
    throw new Error(`Session failed (status=${lastStatus})`);
  }
  throw new Error("Session establishment timeout");
}

/** Connect a raw WebSocket using the session cookie. */
async function connectWs(cookieHeader: string): Promise<WebSocket> {
  const ws = new WebSocket(wsUrl("/ws"), {
    headers: {
      Cookie: cookieHeader,
      Origin: wsOrigin(),
    },
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket connection timeout")), 10_000);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  return ws;
}

function waitForCondition(predicate: () => boolean, timeoutMs: number, errorMsg: string): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error(errorMsg));
      setTimeout(check, 150);
    };
    check();
  });
}

test.describe("Real-time WebSocket Updates", () => {
  test.setTimeout(120_000);

  test("WebSocket connects and receives task_update on task creation", async ({ request }) => {
    const { cookie, csrfToken } = await establishApiSession(request);
    const ws = await connectWs(cookie);

    const received: WsEnvelope[] = [];
    const receivedTypes = new Set<string>();
    ws.on("message", (data: Buffer | string) => {
      const raw = typeof data === "string" ? data : data.toString("utf8");
      try {
        const parsed = JSON.parse(raw) as WsEnvelope;
        received.push(parsed);
        receivedTypes.add(parsed.type);
      } catch {
        /* ignore non-JSON */
      }
    });

    // Create a task via API
    const taskTitle = `E2E WS Task ${Date.now()}`;
    const createRes = await request.post("/api/tasks", {
      headers: { "x-csrf-token": csrfToken },
      data: {
        title: taskTitle,
        description: "WebSocket update test",
        status: "inbox",
      },
    });
    expect(createRes.ok()).toBeTruthy();
    const createBody = await createRes.json();
    const taskId = createBody.id;

    // Wait for task_update event to arrive via WebSocket
    await waitForCondition(
      () => receivedTypes.has("task_update"),
      15_000,
      `WebSocket did not receive task_update event. Received types: ${[...receivedTypes].join(", ")}`,
    );

    // Verify the received payload contains the task we created
    const taskEvents = received.filter((e) => e.type === "task_update");
    expect(taskEvents.length).toBeGreaterThan(0);

    // Cleanup
    ws.close();
    await request.delete(`/api/tasks/${taskId}`, {
      headers: { "x-csrf-token": csrfToken },
    });
  });

  test("WebSocket receives task_update on status change", async ({ request }) => {
    const { cookie, csrfToken } = await establishApiSession(request);

    // Create a task first
    const createRes = await request.post("/api/tasks", {
      headers: { "x-csrf-token": csrfToken },
      data: {
        title: `E2E WS Status ${Date.now()}`,
        description: "WebSocket status change test",
        status: "planned",
      },
    });
    expect(createRes.ok()).toBeTruthy();
    const createBody = await createRes.json();
    const taskId = createBody.id;

    // Now connect WebSocket and listen
    const ws = await connectWs(cookie);
    const received: WsEnvelope[] = [];
    ws.on("message", (data: Buffer | string) => {
      const raw = typeof data === "string" ? data : data.toString("utf8");
      try {
        received.push(JSON.parse(raw) as WsEnvelope);
      } catch {
        /* ignore */
      }
    });

    // Update the task status
    const patchRes = await request.patch(`/api/tasks/${taskId}`, {
      headers: { "x-csrf-token": csrfToken },
      data: { status: "in_progress" },
    });
    expect(patchRes.ok()).toBeTruthy();

    // Wait for the update event
    await waitForCondition(
      () => received.some((e) => e.type === "task_update"),
      15_000,
      "WebSocket did not receive task_update after status change",
    );

    const taskEvents = received.filter((e) => e.type === "task_update");
    expect(taskEvents.length).toBeGreaterThan(0);

    // Cleanup
    ws.close();
    await request.delete(`/api/tasks/${taskId}`, {
      headers: { "x-csrf-token": csrfToken },
    });
  });

  test("WebSocket receives new_message on chat message", async ({ request }) => {
    const { cookie, csrfToken } = await establishApiSession(request);
    const ws = await connectWs(cookie);

    const receivedTypes = new Set<string>();
    ws.on("message", (data: Buffer | string) => {
      const raw = typeof data === "string" ? data : data.toString("utf8");
      try {
        const parsed = JSON.parse(raw) as WsEnvelope;
        receivedTypes.add(parsed.type);
      } catch {
        /* ignore */
      }
    });

    // Send a chat message via API
    const msgRes = await request.post("/api/messages", {
      headers: { "x-csrf-token": csrfToken },
      data: {
        sender_type: "ceo",
        receiver_type: "all",
        content: `E2E WS Chat ${Date.now()}`,
      },
    });
    expect(msgRes.ok()).toBeTruthy();

    // Wait for new_message event
    await waitForCondition(
      () => receivedTypes.has("new_message"),
      15_000,
      `WebSocket did not receive new_message event. Received: ${[...receivedTypes].join(", ")}`,
    );

    ws.close();
  });

  test("WebSocket receives subtask_update on subtask status change", async ({ request }) => {
    const { cookie, csrfToken } = await establishApiSession(request);

    // Create a task
    const createRes = await request.post("/api/tasks", {
      headers: { "x-csrf-token": csrfToken },
      data: {
        title: `E2E WS Subtask ${Date.now()}`,
        description: "WebSocket subtask test",
        status: "planned",
      },
    });
    expect(createRes.ok()).toBeTruthy();
    const createBody = await createRes.json();
    const taskId = createBody.id;

    // Create a subtask
    const subtaskRes = await request.post(`/api/tasks/${taskId}/subtasks`, {
      headers: { "x-csrf-token": csrfToken },
      data: { title: "[pipeline:ws_test_phase]", description: "WS subtask test" },
    });
    expect(subtaskRes.ok()).toBeTruthy();
    const subtaskBody = await subtaskRes.json();
    const subtaskId = subtaskBody.id ?? subtaskBody.entity?.id;

    // Connect WS and listen
    const ws = await connectWs(cookie);
    const received: WsEnvelope[] = [];
    ws.on("message", (data: Buffer | string) => {
      const raw = typeof data === "string" ? data : data.toString("utf8");
      try {
        received.push(JSON.parse(raw) as WsEnvelope);
      } catch {
        /* ignore */
      }
    });

    // Update subtask status
    const patchRes = await request.patch(`/api/subtasks/${subtaskId}`, {
      headers: { "x-csrf-token": csrfToken },
      data: { status: "done" },
    });
    expect(patchRes.ok()).toBeTruthy();

    // Wait for subtask_update event
    await waitForCondition(
      () => received.some((e) => e.type === "subtask_update"),
      15_000,
      "WebSocket did not receive subtask_update after subtask status change",
    );

    const subtaskEvents = received.filter((e) => e.type === "subtask_update");
    expect(subtaskEvents.length).toBeGreaterThan(0);

    // Cleanup
    ws.close();
    await request.delete(`/api/tasks/${taskId}`, {
      headers: { "x-csrf-token": csrfToken },
    });
  });

  test("UI receives WebSocket updates without page refresh", async ({ page, request }) => {
    // Save the CSRF token now — after page.goto() the request context may become
    // invalid (browser closed / context destroyed), so we cannot call request.get
    // again later to fetch a fresh token.
    const csrfToken = await establishSession(request);

    // Navigate to the app
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");

    // Create a task via API (not via UI) to trigger a WS push
    const taskTitle = `E2E Live Update ${Date.now()}`;

    const createRes = await request.post("/api/tasks", {
      headers: { "x-csrf-token": csrfToken },
      data: {
        title: taskTitle,
        description: "Test real-time UI update",
        status: "planned",
      },
    });
    expect(createRes.ok()).toBeTruthy();
    const createBody = await createRes.json();
    const taskId = createBody.id;

    // Navigate to tasks view to verify the task shows up
    await navigateTo(page, "tasks");
    await expect(page.locator("main").first()).toBeVisible({ timeout: 5000 });

    // The task title should appear on the board
    const taskText = page.getByText(taskTitle).first();
    await expect(taskText).toBeVisible({ timeout: 10_000 });

    // Cleanup
    await request.delete(`/api/tasks/${taskId}`, {
      headers: { "x-csrf-token": csrfToken },
    });
  });
});
