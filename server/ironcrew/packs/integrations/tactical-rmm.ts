/**
 * IronCrew — Tactical RMM (amidaware) integration adapter.
 *
 * The MSP pack's eyes on the endpoint fleet: which machines exist, which are
 * online, and what is currently alerting. That is the whole job.
 *
 * READ-ONLY, ON PURPOSE — DO NOT ADD WRITES HERE
 *
 * Tactical RMM's API can run an arbitrary script or a shell command on every
 * managed endpoint (`POST /agents/<agent_id>/runscript/`, `POST
 * /agents/<agent_id>/cmd/`, `POST /agents/<agent_id>/reboot/`). An RMM
 * credential that can do that is the single most dangerous thing an MSP
 * holds: it is remote code execution on every customer at once, which is
 * precisely the path used in the RMM supply-chain incidents of recent years.
 * The pack therefore registers this integration's tools at risk class
 * "read", and this file implements only reads so that the code cannot
 * out-grow the risk class it was reviewed under. Anything that changes state
 * on an endpoint belongs behind a separate, separately-granted adapter with
 * its own risk class — not behind one more method here.
 *
 * DOCUMENTATION USED
 *
 *   https://docs.tacticalrmm.com/functions/api/
 *
 * That page is the authority for two things and is explicit about both: the
 * API key travels in an `X-API-KEY` header, and the trailing slash on every
 * path matters (Django's APPEND_SLASH would otherwise turn a call into a
 * redirect, and a redirect drops the header on some clients). It documents
 * very few endpoints, because Tactical RMM's backend is a Django REST
 * Framework app written for its own Vue frontend. The three endpoints used
 * here were therefore confirmed against the server's own URL configuration
 * rather than guessed:
 *
 *   GET   /core/version/  — core/urls.py -> core/views.py `version()`, which
 *                           returns `settings.APP_VER` as a bare JSON string.
 *                           Authenticated but role-free: the cheapest call
 *                           that tells reachability and auth apart.
 *   GET   /agents/        — agents/urls.py -> `GetAgents`, serialised by
 *                           `AgentTableSerializer` (hostname, client_name,
 *                           site_name, operating_system, status, last_seen,
 *                           needs_reboot, …). `?detail=false` exists but
 *                           drops every field except hostname and ids.
 *   PATCH /alerts/        — alerts/urls.py -> `GetAddAlerts`, serialised by
 *                           `AlertSerializer`.
 *
 * WHY LISTING ALERTS IS A PATCH
 *
 * It looks like a write and is not. Tactical RMM's alert list takes its
 * filter object in a request body, so its own dashboard sends PATCH to read
 * the table; `AlertPerms` in alerts/permissions.py handles GET and PATCH
 * identically and asks only for `can_list_alerts`. A key issued to a
 * read-only role can therefore make this call, and it creates, changes and
 * deletes nothing. Sending GET instead returns 405, so there is no
 * verb-purity option to take here — only a comment saying why.
 *
 * NEVER ECHO THE KEY
 *
 * Every message this adapter emits passes through `redact()`. Not because
 * this file composes one containing the key — it does not — but because a
 * message can arrive from somewhere else already carrying it: a reverse proxy
 * that echoes request headers into its error page, a fetch implementation
 * that stringifies the request init into an exception. The one place a secret
 * leaks unnoticed is an error string, so the scrub happens at the exit, where
 * every path is covered, rather than at each site where one might not be.
 */

import {
  integrationFetch,
  integrationJson,
  normaliseBaseUrl,
  PackIntegrationError,
  type HttpIntegrationOptions,
  type IntegrationStatus,
  type PackIntegrationAdapter,
} from "../pack-integration.ts";

export interface TacticalRmmOptions extends HttpIntegrationOptions {
  /** An API key from Settings → Global Settings → API Keys. Sent as X-API-KEY. */
  apiKey: string;
}

/** One managed endpoint, in IronCrew's words rather than Django's. */
export interface TacticalRmmAgent {
  /** Tactical RMM's own stable id, for deep links and follow-up calls. */
  agentId: string | undefined;
  hostname: string;
  /** The customer this machine belongs to (`client_name` in the API). */
  client: string | undefined;
  /** The location within that customer (`site_name`). */
  site: string | undefined;
  operatingSystem: string | undefined;
  /** True only for the literal status "online"; "overdue" is not online. */
  online: boolean;
  /** The raw status, kept because "overdue" and "offline" mean different things. */
  status: string | undefined;
  /** ISO-8601 as the server sent it — no reformatting, no timezone guessing. */
  lastSeen: string | undefined;
  /** Undefined, not false, when the server did not say: absent is not "no". */
  pendingReboot: boolean | undefined;
}

/** One open alert. */
export interface TacticalRmmAlert {
  id: number | undefined;
  /** "info" | "warning" | "error" per tacticalrmm/constants.py AlertSeverity. */
  severity: string | undefined;
  /** "availability" | "check" | "task" — what kind of thing raised it. */
  alertType: string | undefined;
  /** The agent it concerns, by hostname; absent for server-level alerts. */
  agent: string | undefined;
  client: string | undefined;
  site: string | undefined;
  message: string;
  /** `alert_time`, ISO-8601 as sent. */
  raisedAt: string | undefined;
}

/**
 * The alert filter that means "still open".
 *
 * `GetAddAlerts` applies `resolvedFilter`/`snoozedFilter` only when the value
 * is false, so this object is exactly "unresolved and unsnoozed" and nothing
 * else. Sending an empty body would instead return every alert ever raised,
 * which on a fleet of any size is a page of history, not a work list.
 */
const OPEN_ALERTS_FILTER = JSON.stringify({ resolvedFilter: false, snoozedFilter: false });

interface AgentRow {
  agent_id?: unknown;
  hostname?: unknown;
  client_name?: unknown;
  site_name?: unknown;
  operating_system?: unknown;
  status?: unknown;
  last_seen?: unknown;
  needs_reboot?: unknown;
}

interface AlertRow {
  id?: unknown;
  severity?: unknown;
  alert_type?: unknown;
  hostname?: unknown;
  client?: unknown;
  site?: unknown;
  message?: unknown;
  alert_time?: unknown;
}

export class TacticalRmmAdapter implements PackIntegrationAdapter {
  readonly key = "tactical-rmm";
  readonly label = "Tactical RMM";

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number | undefined;

  constructor(opts: TacticalRmmOptions) {
    this.baseUrl = normaliseBaseUrl(opts.baseUrl);
    const apiKey = (opts.apiKey ?? "").trim();
    // Refused here rather than at the first call: an empty key produces a 401
    // that reads like a wrong key, and an operator would go looking for the
    // wrong problem.
    if (apiKey === "") throw new PackIntegrationError("Der API-Key für Tactical RMM fehlt.");
    this.apiKey = apiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs;
  }

  /**
   * Reachability and auth in one cheap call.
   *
   * `/core/version/` needs a valid key but no role permission, so its answer
   * separates the three states an operator actually has to tell apart: host
   * unreachable, key rejected, and "works — here is the version you are
   * running".
   */
  async testConnection(): Promise<IntegrationStatus> {
    try {
      const version = await this.call<unknown>("/core/version/", "Die Versionsabfrage");
      // `version()` returns `Response(settings.APP_VER)` — a bare JSON string,
      // not an object. Anything else means the URL reached something that is
      // not a Tactical RMM API.
      const text = typeof version === "string" ? version.trim() : "";
      if (text === "") {
        return {
          ok: false,
          message: `Tactical RMM (${this.baseUrl}) antwortet, aber nicht wie die Tactical-RMM-API. Zeigt die Basis-URL auf den API-Host (z. B. https://api.example.com) statt auf die Weboberfläche?`,
        };
      }
      return { ok: true, message: `Tactical RMM erreichbar, API-Key gültig.`, version: text };
    } catch (err) {
      // Reported, never thrown: the Settings panel asks "does this work?", and
      // an exception there is an outage in the page rather than an answer.
      return { ok: false, message: this.redact(err instanceof Error ? err.message : String(err)) };
    }
  }

  /** Every managed endpoint the key may see. Read-only. */
  async listAgents(): Promise<TacticalRmmAgent[]> {
    // `detail=true` is the server's default, and it is spelled out anyway: the
    // default is what the caller inherits, and `detail=false` would silently
    // strip operating system, status, last_seen and needs_reboot from the
    // answer while still returning HTTP 200.
    const rows = await this.call<unknown>("/agents/?detail=true", "Die Agentenliste");
    return this.expectArray(rows, "Die Agentenliste").map((row) => toAgent(row as AgentRow));
  }

  /** Open (unresolved, unsnoozed) alerts. Read-only — see the file header. */
  async listAlerts(): Promise<TacticalRmmAlert[]> {
    const rows = await this.call<unknown>("/alerts/", "Die Alarmliste", {
      method: "PATCH",
      body: OPEN_ALERTS_FILTER,
    });
    return this.expectArray(rows, "Die Alarmliste").map((row) => toAlert(row as AlertRow));
  }

  /** X-API-KEY, per docs.tacticalrmm.com/functions/api/. Not a Bearer token. */
  private headers(hasBody: boolean): Record<string, string> {
    const headers: Record<string, string> = { "X-API-KEY": this.apiKey, Accept: "application/json" };
    if (hasBody) headers["Content-Type"] = "application/json";
    return headers;
  }

  private async call<T>(path: string, what: string, init: { method?: string; body?: string } = {}): Promise<T> {
    let res: Response;
    try {
      res = await integrationFetch(
        this.fetchImpl,
        `${this.baseUrl}${path}`,
        { method: init.method ?? "GET", headers: this.headers(init.body !== undefined), body: init.body },
        this.timeoutMs,
        [this.apiKey],
      );
    } catch (err) {
      // "fetch failed" is not something an operator can act on; the instance's
      // own name is. Same reasoning as SearxngProvider.
      throw new PackIntegrationError(`Tactical RMM (${this.baseUrl}): ${this.redact(errorText(err))}`);
    }

    if (!res.ok) throw new PackIntegrationError(this.explainStatus(res.status, what), res.status);

    try {
      return await integrationJson<T>(res, what);
    } catch (err) {
      const status = err instanceof PackIntegrationError ? err.status : res.status;
      throw new PackIntegrationError(this.redact(errorText(err)), status);
    }
  }

  /**
   * A status code turned into the sentence that names the actual next step.
   *
   * The response body is deliberately never included. A DRF error page, or a
   * reverse proxy in front of it, may echo the request headers — and the
   * request headers are where the API key is.
   */
  private explainStatus(status: number, what: string): string {
    const where = `Tactical RMM (${this.baseUrl})`;
    if (status === 401)
      return `${where}: Der API-Key wurde abgelehnt (HTTP 401). Er ist falsch, abgelaufen oder wurde gelöscht.`;
    if (status === 403)
      return `${where}: Der API-Key hat keine Berechtigung (HTTP 403). ${what} braucht ein Konto, dessen Rolle die Agenten bzw. Alarme lesen darf.`;
    if (status === 404)
      return `${where}: ${what} wurde nicht gefunden (HTTP 404). Zeigt die Basis-URL auf den API-Host (z. B. https://api.example.com) statt auf die Weboberfläche?`;
    if (status === 405) return `${where}: ${what} wurde mit der falschen HTTP-Methode angefragt (HTTP 405).`;
    return `${where}: ${what} ist fehlgeschlagen (HTTP ${status}).`;
  }

  private expectArray(rows: unknown, what: string): unknown[] {
    // An empty list is an answer — no agents, no open alerts — but a non-list
    // means the URL reached something that is not this API, and mapping over
    // it would produce a page of empty rows instead of a readable failure.
    if (!Array.isArray(rows)) throw new PackIntegrationError(`${what} hatte ein unerwartetes Format.`);
    return rows;
  }

  private redact(message: string): string {
    return message.split(this.apiKey).join("***");
  }
}

function toAgent(row: AgentRow): TacticalRmmAgent {
  const status = text(row.status);
  return {
    agentId: text(row.agent_id),
    // A machine with no hostname should still be visible in the list: the
    // gap is the finding, and dropping the row would hide it.
    hostname: text(row.hostname) ?? "(ohne Hostnamen)",
    client: text(row.client_name),
    site: text(row.site_name),
    operatingSystem: text(row.operating_system),
    // tacticalrmm/constants.py: "online" | "offline" | "overdue". "overdue"
    // means the agent has not checked in within its window — not reachable,
    // so not online.
    online: status === "online",
    status,
    lastSeen: text(row.last_seen),
    pendingReboot: flag(row.needs_reboot),
  };
}

function toAlert(row: AlertRow): TacticalRmmAlert {
  return {
    id: typeof row.id === "number" ? row.id : undefined,
    severity: text(row.severity),
    alertType: text(row.alert_type),
    // AlertSerializer exposes the agent as `hostname` (source
    // assigned_agent.hostname); it is null for alerts not tied to an agent.
    agent: text(row.hostname),
    client: text(row.client),
    site: text(row.site),
    message: text(row.message) ?? "",
    raisedAt: text(row.alert_time),
  };
}

/** Empty and whitespace count as absent: Django serialises "no value" both ways. */
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** Only a real boolean. "unknown" and "false" are different answers. */
function flag(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
