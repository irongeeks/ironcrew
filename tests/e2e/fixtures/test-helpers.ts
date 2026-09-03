import { type Page, type APIRequestContext, expect } from "@playwright/test";

// ── Navigation ──────────────────────────────────────────────

export type ViewName =
  | "office"
  | "tasks"
  | "workflows"
  | "operations"
  | "agents"
  | "skills"
  | "projects"
  | "schedules"
  | "settings";

const VIEW_LABELS: Record<ViewName, string> = {
  office: "OFFICE",
  tasks: "TASKS",
  workflows: "WORKFLOWS",
  operations: "OPS",
  agents: "ROSTER",
  skills: "LIBRARY",
  projects: "PROJECTS",
  schedules: "SCHEDULES",
  settings: "SETTINGS",
};

export async function navigateTo(page: Page, view: ViewName): Promise<void> {
  const label = VIEW_LABELS[view];
  const btn = page.getByRole("button", { name: new RegExp(`^${label}$`) });
  await btn.click();
  // Wait for the view content to load after navigation
  await expect(page.locator("main, canvas, [class*=view], [class*=View], section").first()).toBeVisible({
    timeout: 5000,
  });
}

// ── Session ─────────────────────────────────────────────────

export async function establishSession(request: APIRequestContext): Promise<string> {
  const timeout = 30_000;
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const res = await request.get("/api/auth/session");
    if (res.ok()) {
      const body = await res.json();
      const csrfToken = body.csrf_token as string;
      // On fresh databases the SetupWizard (position:fixed; inset:0) overlays the
      // entire UI and intercepts all pointer events, causing every nav click to time out.
      // Mark onboarding complete so the wizard is never rendered during E2E runs.
      await request.put("/api/settings", {
        data: { onboarding_completed: true },
        headers: { "x-csrf-token": csrfToken },
      });
      return csrfToken;
    }
    if ([502, 503, 404].includes(res.status())) {
      await sleep(500);
      continue;
    }
    throw new Error(`Session failed (status=${res.status()})`);
  }
  throw new Error("Session establishment timeout");
}

// ── API Helpers ─────────────────────────────────────────────

export async function expectOkJson<T>(
  response: { ok(): boolean; status(): number; text(): Promise<string> },
  label: string,
): Promise<T> {
  const text = await response.text();
  let parsed: unknown = {};
  if (text.trim()) {
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`${label}: JSON parse error (status=${response.status()}): ${text.slice(0, 500)}`);
    }
  }
  if (!response.ok()) {
    throw new Error(`${label}: Request failed (status=${response.status()}): ${text.slice(0, 1000)}`);
  }
  return parsed as T;
}

// ── Wait Utilities ──────────────────────────────────────────

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function waitForText(page: Page, text: string, timeout = 10_000): Promise<void> {
  await expect(page.getByText(text).first()).toBeVisible({ timeout });
}

export async function waitForTaskStatus(
  request: APIRequestContext,
  taskId: string,
  targetStatus: string,
  timeout = 120_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const res = await request.get(`/api/tasks/${taskId}`);
    if (res.ok()) {
      const task = await res.json();
      if (task.status === targetStatus) return;
    }
    await sleep(1000);
  }
  throw new Error(`Task ${taskId} did not reach status "${targetStatus}" within ${timeout}ms`);
}

// ── WebSocket Helpers ───────────────────────────────────────

export async function waitForWebSocketEvent(page: Page, eventType: string, timeout = 15_000): Promise<unknown> {
  return page.evaluate(
    ({ eventType, timeout }) => {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`WS event "${eventType}" not received within ${timeout}ms`)),
          timeout,
        );
        const origWs = (window as any).__e2eWs;
        if (!origWs) {
          clearTimeout(timer);
          reject(new Error("No WebSocket found on window.__e2eWs"));
          return;
        }
        const origOnMessage = origWs.onmessage;
        origWs.onmessage = (ev: MessageEvent) => {
          if (origOnMessage) origOnMessage.call(origWs, ev);
          try {
            const data = JSON.parse(ev.data);
            if (data.type === eventType) {
              clearTimeout(timer);
              origWs.onmessage = origOnMessage;
              resolve(data);
            }
          } catch {
            /* ignore non-JSON */
          }
        };
      });
    },
    { eventType, timeout },
  );
}

// ── Form Helpers ────────────────────────────────────────────

export async function fillInput(page: Page, label: string, value: string): Promise<void> {
  const input = page.getByLabel(label);
  await input.click();
  await input.fill(value);
}

export async function fillPlaceholder(page: Page, placeholder: string, value: string): Promise<void> {
  const input = page.getByPlaceholder(placeholder);
  await input.click();
  await input.fill(value);
}

// ── Cleanup ─────────────────────────────────────────────────

export async function deleteViaApi(request: APIRequestContext, path: string, csrfToken?: string): Promise<void> {
  const options = csrfToken ? { headers: { "x-csrf-token": csrfToken } } : {};
  await request.delete(path, options);
}
