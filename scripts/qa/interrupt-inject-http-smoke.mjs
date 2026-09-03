#!/usr/bin/env node
/* global process, setTimeout, console, fetch, Headers */

const baseUrl = (process.env.SMOKE_BASE_URL || "http://127.0.0.1:18790").replace(/\/$/, "");
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS || 20000);
const pollMs = Number(process.env.SMOKE_POLL_MS || 600);

const jar = {
  cookie: "",
  csrfToken: "",
};

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function parseCookie(setCookieHeaders) {
  const first = Array.isArray(setCookieHeaders) ? setCookieHeaders[0] : setCookieHeaders;
  if (!first || typeof first !== "string") return "";
  const pair = first.split(";", 1)[0]?.trim();
  return pair || "";
}

async function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (jar.cookie) headers.set("cookie", jar.cookie);
  if (options.withCsrf && jar.csrfToken) headers.set("x-csrf-token", jar.csrfToken);
  if (options.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const res = await fetch(`${baseUrl}${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const rawSetCookie = res.headers.get("set-cookie");
  if (rawSetCookie) {
    const cookie = parseCookie(rawSetCookie);
    if (cookie) jar.cookie = cookie;
  }

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  return { status: res.status, json, text };
}

async function waitForInterruptProof(taskId) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const term = await request(`/api/tasks/${encodeURIComponent(taskId)}/terminal?lines=200&pretty=1&log_limit=200`);
    if (term.status === 200 && term.json?.interrupt?.session_id && term.json?.interrupt?.control_token) {
      return term.json.interrupt;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error("interrupt proof was not available in terminal payload before timeout");
}

(async () => {
  console.log(`[smoke] base=${baseUrl}`);

  const session = await request("/api/auth/session");
  assert(session.status === 200, `session bootstrap failed (${session.status})`);
  assert(session.json?.csrf_token, "csrf_token missing from /api/auth/session");
  jar.csrfToken = session.json.csrf_token;

  const agentsRes = await request("/api/agents");
  assert(agentsRes.status === 200, `GET /api/agents failed (${agentsRes.status})`);
  const agents = agentsRes.json?.agents || [];
  assert(Array.isArray(agents) && agents.length > 0, "no agents found");
  const agent = agents.find((row) => row?.status !== "offline") || agents[0];
  assert(agent?.id, "failed to select an agent");

  const createTaskRes = await request("/api/tasks", {
    method: "POST",
    withCsrf: true,
    body: {
      title: `smoke interrupt inject ${new Date().toISOString()}`,
      description: "HTTP smoke for pause -> inject -> resume",
      priority: 2,
    },
  });
  assert(createTaskRes.status === 200, `POST /api/tasks failed (${createTaskRes.status})`);
  const taskId = createTaskRes.json?.id;
  assert(taskId, "task id missing from create response");

  const assignRes = await request(`/api/tasks/${encodeURIComponent(taskId)}/assign`, {
    method: "POST",
    withCsrf: true,
    body: { agent_id: agent.id },
  });
  assert(assignRes.status === 200, `assign failed (${assignRes.status})`);

  const runRes = await request(`/api/tasks/${encodeURIComponent(taskId)}/run`, {
    method: "POST",
    withCsrf: true,
    body: {},
  });
  assert(runRes.status === 200, `run failed (${runRes.status})`);

  const interrupt = await waitForInterruptProof(taskId);

  const pauseRes = await request(`/api/tasks/${encodeURIComponent(taskId)}/stop`, {
    method: "POST",
    withCsrf: true,
    body: {
      mode: "pause",
      session_id: interrupt.session_id,
      interrupt_token: interrupt.control_token,
    },
  });
  assert(pauseRes.status === 200, `pause failed (${pauseRes.status})`);

  const injectRes = await request(`/api/tasks/${encodeURIComponent(taskId)}/inject`, {
    method: "POST",
    withCsrf: true,
    body: {
      session_id: interrupt.session_id,
      interrupt_token: interrupt.control_token,
      prompt: "Run tests first, then continue implementation.",
    },
  });
  assert(injectRes.status === 200, `inject failed (${injectRes.status})`);
  assert(injectRes.json?.queued === true, "inject response missing queued=true");

  const resumeRes = await request(`/api/tasks/${encodeURIComponent(taskId)}/resume`, {
    method: "POST",
    withCsrf: true,
    body: {},
  });
  assert(resumeRes.status === 200, `resume failed (${resumeRes.status})`);

  const terminalRes = await request(
    `/api/tasks/${encodeURIComponent(taskId)}/terminal?lines=200&pretty=1&log_limit=400`,
  );
  assert(terminalRes.status === 200, `terminal read failed (${terminalRes.status})`);
  const taskLogs = terminalRes.json?.task_logs || [];
  const hasInjectQueuedLog = taskLogs.some(
    (row) => typeof row?.message === "string" && row.message.includes("INJECT queued"),
  );
  const hasResumeLog = taskLogs.some((row) => typeof row?.message === "string" && row.message.includes("RESUME"));
  assert(hasInjectQueuedLog, "missing INJECT queued task log");
  assert(hasResumeLog, "missing RESUME task log");

  console.log(
    `[smoke] ok task_id=${taskId} agent_id=${agent.id} pause=${pauseRes.status} inject=${injectRes.status} resume=${resumeRes.status}`,
  );
})().catch((error) => {
  console.error(`[smoke] failed: ${error?.message || String(error)}`);
  process.exitCode = 1;
});
