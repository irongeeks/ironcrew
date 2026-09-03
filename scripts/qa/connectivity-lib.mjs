import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

export const BASE_URL = process.env.CLAW_BASE_URL ?? "http://127.0.0.1:8790";
export const LATENCY_SLA_MS = asPositiveInt(Number.parseInt(process.env.COMM_TEST_SLA_MS ?? "3000", 10), 3000);
export const REQUEST_TIMEOUT_MS = asPositiveInt(
  Number.parseInt(process.env.COMM_TEST_TIMEOUT_MS ?? "15000", 10),
  15000,
);
export const RETRY_COUNT = asNonNegativeInt(Number.parseInt(process.env.COMM_TEST_RETRY_COUNT ?? "0", 10), 0);
export const API_PROVIDER_ID_FILTER = String(process.env.COMM_TEST_API_PROVIDER_ID ?? "").trim();
export const API_PROVIDER_NAME_FILTER = String(process.env.COMM_TEST_API_PROVIDER_NAME ?? "")
  .trim()
  .toLowerCase();
export const LOGS_DIR = path.resolve(process.cwd(), "logs");
export const DOCS_DIR = path.resolve(process.cwd(), "docs");

export function nowIso() {
  return new Date().toISOString();
}

export function fileTimestamp() {
  return nowIso().replace(/[:.]/g, "-");
}

export function asPositiveInt(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function asNonNegativeInt(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

export function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function trimString(value, max = 500) {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}... (${value.length - max} chars truncated)`;
}

export function sanitize(value, depth = 0) {
  if (depth > 4) return "[max-depth]";
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return trimString(value);
  if (Array.isArray(value)) {
    const limit = 20;
    const out = value.slice(0, limit).map((entry) => sanitize(entry, depth + 1));
    if (value.length > limit) out.push(`... (${value.length - limit} more items)`);
    return out;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    const limit = 40;
    const out = {};
    for (const [key, entry] of entries.slice(0, limit)) {
      out[key] = sanitize(entry, depth + 1);
    }
    if (entries.length > limit) out.__truncated_keys = entries.length - limit;
    return out;
  }
  return String(value);
}

export function parseCookieHeader(setCookie) {
  if (!setCookie || typeof setCookie !== "string") return null;
  const cookiePair = setCookie.split(";")[0]?.trim();
  return cookiePair || null;
}

export function withinSla(response, latencySlaMs = LATENCY_SLA_MS) {
  return typeof response.elapsed_ms === "number" && response.elapsed_ms <= latencySlaMs;
}

export function ensureDirectory(directoryPath) {
  if (!fs.existsSync(directoryPath)) {
    fs.mkdirSync(directoryPath, { recursive: true });
  }
}

export function toPosixRelativePath(absolutePath) {
  return path.relative(process.cwd(), absolutePath).replace(/\\/g, "/");
}

export function safeFileSlug(value, fallback = "ad-hoc") {
  if (!value || typeof value !== "string") return fallback;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-");
  const trimmed = normalized.replace(/^-+/, "").replace(/-+$/, "");
  return trimmed || fallback;
}

export function pickApiProvider(enabledProviders) {
  if (!Array.isArray(enabledProviders) || enabledProviders.length === 0) return null;
  if (API_PROVIDER_ID_FILTER) {
    return enabledProviders.find((provider) => String(provider.id ?? "") === API_PROVIDER_ID_FILTER) ?? null;
  }
  if (API_PROVIDER_NAME_FILTER) {
    return (
      enabledProviders.find(
        (provider) =>
          String(provider.name ?? "")
            .trim()
            .toLowerCase() === API_PROVIDER_NAME_FILTER,
      ) ?? null
    );
  }
  return enabledProviders[0] ?? null;
}

export async function httpJson({ method = "GET", endpoint, body, cookie, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const url = new URL(endpoint, BASE_URL).toString();
  const startedAt = nowIso();
  const startedPerf = performance.now();
  const headers = { Accept: "application/json" };
  if (cookie) headers.Cookie = cookie;
  let payload;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: payload,
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // Keep raw text response when JSON parsing fails.
    }

    return {
      ok: response.ok,
      status: response.status,
      started_at: startedAt,
      elapsed_ms: Math.round((performance.now() - startedPerf) * 100) / 100,
      method,
      endpoint,
      url,
      set_cookie: response.headers.get("set-cookie"),
      body: parsed,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      started_at: startedAt,
      elapsed_ms: Math.round((performance.now() - startedPerf) * 100) / 100,
      method,
      endpoint,
      url,
      set_cookie: null,
      body: null,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

export function recordEvidence(evidence, step, response, extra = {}) {
  evidence.push({
    step,
    request: {
      method: response.method,
      endpoint: response.endpoint,
      started_at: response.started_at,
      ...(isRecord(extra.request) ? extra.request : {}),
    },
    response: {
      status: response.status,
      elapsed_ms: response.elapsed_ms,
      ok: response.ok,
      within_sla: withinSla(response),
      error: response.error,
      body: sanitize(response.body),
      ...(isRecord(extra.response) ? extra.response : {}),
    },
  });
}

export async function createSessionContext({ includeHealth = true } = {}) {
  const evidence = [];
  const auth = await httpJson({
    method: "GET",
    endpoint: "/api/auth/session",
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
  recordEvidence(evidence, "auth_session", auth, {
    response: { within_sla: undefined },
  });

  const sessionCookie = parseCookieHeader(auth.set_cookie);
  if (!auth.ok || !sessionCookie) {
    throw new Error(
      "Session authentication failed on /api/auth/session. " +
        "Run the script on loopback or set up API auth before retrying.",
    );
  }

  const requestWithSession = (params) =>
    httpJson({
      ...params,
      cookie: sessionCookie,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });

  if (includeHealth) {
    const health = await requestWithSession({ method: "GET", endpoint: "/api/health" });
    recordEvidence(evidence, "health", health, {
      response: { within_sla: undefined },
    });
  }

  return {
    evidence,
    requestWithSession,
    baseUrl: BASE_URL,
    latencySlaMs: LATENCY_SLA_MS,
    timeoutMs: REQUEST_TIMEOUT_MS,
  };
}

export async function runLlmConnectivityTest(context, { attempt = 1 } = {}) {
  const { requestWithSession, evidence, latencySlaMs } = context;
  const llmResp = await requestWithSession({ method: "POST", endpoint: "/api/cli-usage/refresh" });
  recordEvidence(evidence, `llm_cli_usage_refresh_attempt_${attempt}`, llmResp);

  const llmBody = isRecord(llmResp.body) ? llmResp.body : {};
  const llmUsage = isRecord(llmBody.usage) ? llmBody.usage : {};
  const healthyProviders = Object.entries(llmUsage)
    .filter(([, entry]) => isRecord(entry) && entry.error === null)
    .map(([provider]) => provider);

  const pass = Boolean(
    llmResp.ok && llmBody.ok === true && healthyProviders.length > 0 && withinSla(llmResp, latencySlaMs),
  );

  return {
    id: "llm",
    area: "LLM",
    attempt,
    pass,
    method: "POST",
    endpoint: "/api/cli-usage/refresh",
    status: llmResp.status,
    latency_ms: llmResp.elapsed_ms,
    within_sla: withinSla(llmResp, latencySlaMs),
    healthy_providers: healthyProviders,
    note: pass
      ? "At least one LLM provider usage payload returned error=null."
      : "No healthy LLM provider usage response met acceptance criteria.",
    response: sanitize(llmResp.body),
    error: llmResp.error,
    acceptance_rule:
      "POST /api/cli-usage/refresh returns HTTP 200, body.ok=true, and usage provider error=null within SLA.",
  };
}

export async function runOAuthConnectivityTest(context, { attempt = 1 } = {}) {
  const { requestWithSession, evidence, latencySlaMs } = context;
  const oauthStatusResp = await requestWithSession({ method: "GET", endpoint: "/api/oauth/status" });
  recordEvidence(evidence, `oauth_status_attempt_${attempt}`, oauthStatusResp);

  const oauthStatusBody = isRecord(oauthStatusResp.body) ? oauthStatusResp.body : {};
  const oauthProviders = isRecord(oauthStatusBody.providers) ? oauthStatusBody.providers : {};
  const connectedProviders = Object.entries(oauthProviders)
    .filter(([, info]) => isRecord(info) && info.connected === true)
    .map(([provider]) => provider);

  let oauthTestType = "none";
  let oauthTestEndpoint = null;
  let oauthTestMethod = null;
  let oauthTestResponse = null;
  let pass = false;
  let note = "";

  const antigravity = isRecord(oauthProviders.antigravity) ? oauthProviders.antigravity : null;
  const antigravityActive =
    antigravity && typeof antigravity.activeAccountId === "string" ? antigravity.activeAccountId : null;

  if (antigravity && antigravity.connected === true && antigravity.hasRefreshToken === true && antigravityActive) {
    oauthTestType = "token_refresh_roundtrip";
    oauthTestEndpoint = "/api/oauth/refresh";
    oauthTestMethod = "POST";
    oauthTestResponse = await requestWithSession({
      method: oauthTestMethod,
      endpoint: oauthTestEndpoint,
      body: { provider: "antigravity", account_id: antigravityActive },
    });
    const body = isRecord(oauthTestResponse.body) ? oauthTestResponse.body : {};
    pass = Boolean(oauthTestResponse.ok && body.ok === true && withinSla(oauthTestResponse, latencySlaMs));
    note = pass
      ? "Google Antigravity token refresh roundtrip succeeded."
      : "Google Antigravity token refresh roundtrip failed or exceeded SLA.";
  } else {
    const copilot = isRecord(oauthProviders["github-copilot"]) ? oauthProviders["github-copilot"] : null;
    if (copilot && copilot.connected === true) {
      oauthTestType = "copilot_model_fetch";
      oauthTestEndpoint = "/api/oauth/models?refresh=true";
      oauthTestMethod = "GET";
      oauthTestResponse = await requestWithSession({
        method: oauthTestMethod,
        endpoint: oauthTestEndpoint,
      });
      const body = isRecord(oauthTestResponse.body) ? oauthTestResponse.body : {};
      const models = isRecord(body.models) && Array.isArray(body.models.copilot) ? body.models.copilot : [];
      pass = Boolean(oauthTestResponse.ok && models.length > 0 && withinSla(oauthTestResponse, latencySlaMs));
      note = pass ? "GitHub Copilot model fetch succeeded." : "GitHub Copilot model fetch failed or exceeded SLA.";
    } else {
      note = "No connected OAuth provider found in /api/oauth/status.";
    }
  }

  if (oauthTestResponse) {
    recordEvidence(evidence, `oauth_${oauthTestType}_attempt_${attempt}`, oauthTestResponse);
  }

  return {
    id: "oauth",
    area: "OAuth",
    attempt,
    pass,
    method: oauthTestMethod,
    endpoint: oauthTestEndpoint,
    status: oauthTestResponse?.status ?? oauthStatusResp.status,
    latency_ms: oauthTestResponse?.elapsed_ms ?? null,
    within_sla: oauthTestResponse ? withinSla(oauthTestResponse, latencySlaMs) : false,
    connected_providers: connectedProviders,
    test_type: oauthTestType,
    note,
    response: sanitize(oauthTestResponse?.body ?? oauthStatusResp.body),
    error: oauthTestResponse?.error ?? oauthStatusResp.error,
    acceptance_rule:
      "OAuth status connected + selected refresh/model endpoint succeeds with expected payload within SLA.",
  };
}

export async function runApiConnectivityTest(context, { attempt = 1 } = {}) {
  const { requestWithSession, evidence, latencySlaMs } = context;
  const apiProvidersResp = await requestWithSession({ method: "GET", endpoint: "/api/api-providers" });
  recordEvidence(evidence, `api_provider_list_attempt_${attempt}`, apiProvidersResp);

  const apiProvidersBody = isRecord(apiProvidersResp.body) ? apiProvidersResp.body : {};
  const apiProviders = Array.isArray(apiProvidersBody.providers) ? apiProvidersBody.providers : [];
  const enabledProviders = apiProviders.filter((provider) => isRecord(provider) && provider.enabled !== false);

  const selectedProvider = pickApiProvider(enabledProviders);
  let selectedResult = null;
  let note = "";

  if (!apiProvidersResp.ok) {
    note = "Failed to fetch API provider list.";
  } else if (enabledProviders.length === 0) {
    note = "No enabled API provider found in /api/api-providers.";
  } else if (!selectedProvider) {
    const filterMessage = API_PROVIDER_ID_FILTER ? `id=${API_PROVIDER_ID_FILTER}` : `name=${API_PROVIDER_NAME_FILTER}`;
    note = `Configured API provider filter (${filterMessage}) did not match an enabled provider.`;
  } else {
    const providerId = String(selectedProvider.id ?? "");
    const providerName = String(selectedProvider.name ?? providerId);
    const providerType = String(selectedProvider.type ?? "unknown");
    const endpoint = `/api/api-providers/${encodeURIComponent(providerId)}/test`;
    const testResp = await requestWithSession({ method: "POST", endpoint });
    recordEvidence(
      evidence,
      `api_provider_test_${safeFileSlug(providerName, providerId)}_attempt_${attempt}`,
      testResp,
    );

    const body = isRecord(testResp.body) ? testResp.body : {};
    const providerPass = Boolean(testResp.ok && body.ok === true && withinSla(testResp, latencySlaMs));

    selectedResult = {
      provider_id: providerId,
      provider_name: providerName,
      provider_type: providerType,
      pass: providerPass,
      status: testResp.status,
      latency_ms: testResp.elapsed_ms,
      within_sla: withinSla(testResp, latencySlaMs),
      error: testResp.error,
      response: sanitize(testResp.body),
    };

    note = providerPass
      ? "Selected API provider passed one connectivity test."
      : "Selected API provider failed connectivity check or exceeded SLA.";
  }

  const providerResults = selectedResult ? [selectedResult] : [];
  const pass = Boolean(apiProvidersResp.ok && selectedResult?.pass === true);

  return {
    id: "api",
    area: "API",
    attempt,
    pass,
    method: "POST",
    endpoint: "/api/api-providers/:id/test",
    status: selectedResult?.status ?? apiProvidersResp.status,
    latency_ms: selectedResult?.latency_ms ?? null,
    within_sla: selectedResult?.within_sla ?? false,
    provider_count: enabledProviders.length,
    selected_provider_id: selectedResult?.provider_id ?? null,
    selected_provider_name: selectedResult?.provider_name ?? null,
    provider_results: providerResults,
    note,
    response: sanitize(apiProvidersResp.body),
    error: apiProvidersResp.error,
    acceptance_rule: "One selected enabled provider returns ok=true from /api/api-providers/:id/test within SLA.",
  };
}

export function writeJsonArtifact(data, { prefix }) {
  ensureDirectory(LOGS_DIR);
  const outputPath = path.join(LOGS_DIR, `${prefix}-${fileTimestamp()}.json`);
  fs.writeFileSync(outputPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  return outputPath;
}

export function writeMarkdownArtifact(content, { fileName }) {
  ensureDirectory(DOCS_DIR);
  const outputPath = path.join(DOCS_DIR, fileName);
  fs.writeFileSync(outputPath, content, "utf8");
  return outputPath;
}

export function formatLatency(ms) {
  if (typeof ms !== "number" || Number.isNaN(ms)) return "-";
  return `${Math.round(ms)}ms`;
}

export function summarizeApiProviders(providerResults) {
  if (!Array.isArray(providerResults) || providerResults.length === 0) return "none";
  return providerResults
    .map(
      (provider) =>
        `${provider.provider_name}:${provider.pass ? "PASS" : "FAIL"}(${formatLatency(provider.latency_ms)})`,
    )
    .join(", ");
}
