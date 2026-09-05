/**
 * IronCrew — UniFi Network integration adapter (read-only).
 *
 * WHICH GENERATION THIS TARGETS
 *
 * Ubiquiti ships two local APIs and they are not variants of one another:
 *
 *  1. The **legacy controller API**: `POST /api/login` with a username and a
 *     password, a session cookie, a CSRF token, then `/api/s/<site>/stat/…`.
 *     Never officially documented, reshaped between releases, and it forces an
 *     operator to store an *account password* in IronCrew.
 *  2. The **UniFi Network Integration API v1** on UniFi OS: a single
 *     `X-API-KEY` header against `/proxy/network/integration/v1/…`, published
 *     and versioned by Ubiquiti with a real OpenAPI document.
 *
 * This adapter implements **(2) only**. An API key is a credential the
 * operator can scope and revoke in one click without touching the account that
 * owns the console; a stored password is a credential that also opens the SSH
 * console and the cloud account. There is no cookie to refresh, no CSRF token
 * to chase, and no re-login race between two concurrent probes.
 *
 * It therefore does **NOT** support: pre-UniFi-OS controllers (self-hosted
 * `unifi` Debian package without UniFi OS in front), the cookie/`/api/login`
 * flow, the cloud path via `api.ui.com/v1/connector/consoles/…`, UniFi Protect
 * / Access / Talk, or any legacy `/api/s/<site>/…` endpoint. On such a host
 * `testConnection()` answers with the 404 rather than silently falling back —
 * a fallback to an undocumented API is how an adapter starts lying about which
 * API it speaks.
 *
 * DOCUMENTATION
 *
 * - Machine-readable source of truth used to write this file:
 *   https://developer.ui.com/network/v10.3.58/openapi.json
 * - Browsable reference: https://developer.ui.com/network/
 * - Key creation + `X-API-KEY` header:
 *   https://help.ui.com/hc/en-us/articles/30076656117655-Getting-Started-with-the-Official-UniFi-API
 *
 * Every path, query parameter and field name below is taken from that OpenAPI
 * document; nothing here is guessed. Where the API does not expose something
 * the caller might expect (client network name, device uptime on the list
 * endpoint), that is written down at the call site instead of being invented.
 *
 * TLS: WE DO NOT TURN VERIFICATION OFF
 *
 * A self-hosted console almost always presents a self-signed certificate, and
 * every UniFi snippet on the internet answers that with `curl -k` or
 * `rejectUnauthorized: false`. This adapter offers no such option and never
 * touches the TLS agent. An adapter that disables verification to be
 * convenient is an adapter that cannot tell its own controller from an
 * attacker sitting between them — and it carries an API key into that
 * connection. The operator trusts the console's CA at the OS level (or gives
 * the console a real certificate); until then `testConnection()` reports the
 * certificate error, which is the true answer.
 *
 * READ-ONLY, ON PURPOSE
 *
 * The Integration API can adopt devices, restart them, write firewall
 * policies and forget clients. None of that is here. These packs feed an
 * *agent*, and an agent that can restart the gateway it is diagnosing can take
 * the company offline while explaining why it did. Read is reversible;
 * everything else needs a human at a keyboard, in the UniFi UI, where the
 * change is attributable.
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

export interface UnifiAdapterOptions extends HttpIntegrationOptions {
  /** API key from UniFi Network → Settings → Control Plane → Integrations. */
  apiKey: string;
  /**
   * Site to read. Accepts the site UUID, its `internalReference` (the legacy
   * short name, usually "default") or its display name. Omitted, the adapter
   * resolves the site itself — see `resolveSiteId()`.
   */
  site?: string;
}

/** Everything the Integration API hangs off. Confirmed in the OpenAPI servers list. */
const API_PREFIX = "/proxy/network/integration/v1";

/** The API's own maximum for `limit`; asking for more is a 400, not a bigger page. */
const PAGE_SIZE = 200;

/**
 * Stop after this many pages (40 000 rows).
 *
 * A paging loop that trusts the server's `totalCount` to eventually be reached
 * is a loop a wrong `totalCount` turns into an infinite one, holding the
 * request open until the operator's page times out.
 */
const MAX_PAGES = 200;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface UnifiSite {
  id: string;
  name: string;
  /** The short name older APIs used, e.g. "default". */
  internalReference: string;
}

export interface UnifiDevice {
  id: string;
  name: string;
  model: string;
  macAddress: string;
  ipAddress?: string;
  /** ONLINE, OFFLINE, UPDATING, PENDING_ADOPTION, … (API enum, passed through). */
  state: string;
  adopted: boolean;
  firmwareVersion?: string;
  firmwareUpdatable?: boolean;
  /** Only populated when `listDevices({ withUptime: true })` was asked for. */
  uptimeSec?: number;
}

export type UnifiClientConnection = "wired" | "wireless" | "vpn" | "teleport" | "unknown";

export interface UnifiClient {
  id: string;
  /**
   * The API's `name`. v1 has no separate `hostname` field — the legacy
   * controller's `hostname`/`name` split does not exist here, so reporting a
   * "hostname" would mean inventing one.
   */
  name: string;
  /** Absent for VPN and Teleport connections: those have no client MAC. */
  macAddress?: string;
  ipAddress?: string;
  /** ISO-8601 timestamp, the API's `connectedAt`. */
  connectedAt?: string;
  connection: UnifiClientConnection;
  /** undefined rather than false for VPN/Teleport, which are neither. */
  wired?: boolean;
  /** "DEFAULT" or "GUEST" — the only two values v1 documents. */
  accessType?: string;
  /** The switch or AP this client hangs off, when the API knows it. */
  uplinkDeviceId?: string;
}

export class UnifiAdapter implements PackIntegrationAdapter {
  readonly key = "unifi";
  readonly label = "UniFi Network";

  private readonly baseUrl: string;
  private readonly host: string;
  private readonly apiKey: string;
  private readonly configuredSite?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs?: number;

  /**
   * Cached site lookup. Resolving the site costs an extra round trip, and
   * `listDevices()` + `listClients()` would otherwise pay it twice for an
   * answer that does not change between two calls.
   */
  private siteIdPromise?: Promise<string>;

  constructor(opts: UnifiAdapterOptions) {
    this.baseUrl = normaliseBaseUrl(opts.baseUrl);
    this.host = hostOf(this.baseUrl);
    const apiKey = (opts.apiKey ?? "").trim();
    if (apiKey === "") throw new PackIntegrationError("Der UniFi-API-Schlüssel fehlt.");
    this.apiKey = apiKey;
    const site = opts.site?.trim();
    this.configuredSite = site === "" ? undefined : site;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs;
  }

  /**
   * Reachability *and* auth in one call.
   *
   * `/v1/info` is the cheapest endpoint that still requires the key: it needs
   * no site, returns one field, and answers 401 for a bad key. A probe against
   * `/sites` would work too but pays for a site listing to learn nothing more.
   */
  async testConnection(): Promise<IntegrationStatus> {
    try {
      const info = await this.request<{ applicationVersion?: unknown }>("/info", "UniFi-Verbindungstest");
      const version = typeof info?.applicationVersion === "string" ? info.applicationVersion : undefined;
      return {
        ok: true,
        message: `UniFi Network auf ${this.host} erreichbar${version ? ` (Version ${version})` : ""}.`,
        ...(version ? { version } : {}),
      };
    } catch (err) {
      // Reported, never thrown: the Settings panel asks "does this work?", and
      // an exception there is an outage in the page rather than an answer.
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  /** GET /v1/sites — the site UUID every other call needs. */
  async listSites(opts: { maxPages?: number } = {}): Promise<UnifiSite[]> {
    const rows = await this.listAll<RawSite>("/sites", "UniFi-Standorte", opts.maxPages);
    return rows.map(toSite);
  }

  /**
   * GET /v1/sites/{siteId}/devices — adopted devices only.
   *
   * `withUptime` is opt-in because uptime is genuinely not on this endpoint:
   * the OpenAPI document puts `uptimeSec` on
   * `/devices/{deviceId}/statistics/latest`, so filling it costs one extra
   * request *per device*. A dashboard listing 60 access points should decide
   * whether it wants 61 requests; it should not discover them.
   */
  async listDevices(opts: { withUptime?: boolean; maxPages?: number } = {}): Promise<UnifiDevice[]> {
    const siteId = await this.resolveSiteId(opts.maxPages);
    const rows = await this.listAll<RawDevice>(
      `/sites/${encodeURIComponent(siteId)}/devices`,
      "UniFi-Geräte",
      opts.maxPages,
    );
    const devices = rows.map(toDevice);
    if (!opts.withUptime) return devices;

    // Sequential, not Promise.all: a console is a small appliance, and firing
    // 60 simultaneous requests at it is a load test wearing a monitoring hat.
    for (const device of devices) {
      device.uptimeSec = await this.deviceUptimeSec(siteId, device.id);
    }
    return devices;
  }

  /**
   * GET /v1/sites/{siteId}/clients — currently connected clients.
   *
   * The v1 client object carries no network/VLAN name: the OpenAPI schema has
   * `id`, `name`, `type`, `ipAddress`, `connectedAt`, `macAddress`,
   * `uplinkDeviceId` and `access`, and nothing that joins to
   * `/v1/sites/{siteId}/networks`. So this returns no `network` field rather
   * than a fabricated one — a field that is always wrong is worse than a field
   * that is absent.
   */
  async listClients(): Promise<UnifiClient[]> {
    const siteId = await this.resolveSiteId();
    const rows = await this.listAll<RawClient>(`/sites/${encodeURIComponent(siteId)}/clients`, "UniFi-Clients");
    return rows.map(toClient);
  }

  /**
   * The site UUID, resolved once.
   *
   * A configured UUID is used verbatim — no lookup, so a key scoped to one
   * site is not forced through a listing it may not be allowed to read. Any
   * other string is matched against `internalReference`, `name` and `id`,
   * because operators know their site as "default" or "Hauptstandort", not as
   * a UUID. With nothing configured, "default" wins if it exists; otherwise
   * the first site, which on a single-site console is the only one.
   */
  private async resolveSiteId(maxPages?: number): Promise<string> {
    if (this.configuredSite && UUID_RE.test(this.configuredSite)) return this.configuredSite;
    if (!this.siteIdPromise) {
      // A failed lookup must not be cached: a console that was briefly down
      // would otherwise stay "broken" for the lifetime of this adapter.
      this.siteIdPromise = this.lookupSiteId(maxPages).catch((err: unknown) => {
        this.siteIdPromise = undefined;
        throw err;
      });
    }
    return this.siteIdPromise;
  }

  private async lookupSiteId(maxPages?: number): Promise<string> {
    const sites = await this.listSites({ maxPages });
    if (sites.length === 0) {
      throw new PackIntegrationError(`UniFi-Standorte: ${this.host} meldet keinen Standort.`);
    }
    const wanted = this.configuredSite?.toLowerCase();
    if (wanted !== undefined) {
      const hit = sites.find(
        (s) =>
          s.internalReference.toLowerCase() === wanted ||
          s.name.toLowerCase() === wanted ||
          s.id.toLowerCase() === wanted,
      );
      if (!hit) {
        const known = sites.map((s) => s.internalReference || s.name).join(", ");
        throw new PackIntegrationError(`UniFi-Standort "${this.configuredSite}" existiert nicht. Verfügbar: ${known}.`);
      }
      return hit.id;
    }
    return (sites.find((s) => s.internalReference === "default") ?? sites[0]).id;
  }

  private async deviceUptimeSec(siteId: string, deviceId: string): Promise<number | undefined> {
    const stats = await this.request<{ uptimeSec?: unknown }>(
      `/sites/${encodeURIComponent(siteId)}/devices/${encodeURIComponent(deviceId)}/statistics/latest`,
      "UniFi-Gerätestatistik",
    );
    return typeof stats?.uptimeSec === "number" ? stats.uptimeSec : undefined;
  }

  /** Walks the `offset`/`limit`/`totalCount` envelope every list endpoint uses. */
  private async listAll<T>(path: string, what: string, maxPages = MAX_PAGES): Promise<T[]> {
    const rows: T[] = [];
    for (let page = 0; page < Math.max(1, Math.min(MAX_PAGES, maxPages)); page += 1) {
      const query = `?offset=${rows.length}&limit=${PAGE_SIZE}`;
      const body = await this.request<RawPage<T>>(`${path}${query}`, what);
      if (!Array.isArray(body?.data)) throw new PackIntegrationError(`${what}: ungültige Datenliste.`);
      const batch = body.data;
      rows.push(...batch);
      // An empty page ends the walk even if `totalCount` disagrees; without
      // that guard a server that reports more than it serves loops forever.
      if (batch.length === 0) break;
      const total = typeof body?.totalCount === "number" ? body.totalCount : rows.length;
      if (rows.length >= total) break;
    }
    return rows;
  }

  /**
   * One authenticated GET.
   *
   * The key travels in a header and never in the URL, so nothing that logs or
   * reports a URL — including the error messages below — can carry it.
   */
  private async request<T>(path: string, what: string): Promise<T> {
    const res = await integrationFetch(
      this.fetchImpl,
      `${this.baseUrl}${API_PREFIX}${path}`,
      { method: "GET", headers: { "X-API-KEY": this.apiKey, Accept: "application/json" } },
      this.timeoutMs,
      [this.apiKey],
    );
    if (!res.ok) throw this.httpError(res.status, what);
    return integrationJson<T>(res, what);
  }

  /**
   * Status → message, never the response body.
   *
   * UniFi's error envelope is harmless today, but a body is the one place a
   * future firmware could echo the credential back, and an error message is
   * exactly what gets pasted into a ticket.
   */
  private httpError(status: number, what: string): PackIntegrationError {
    if (status === 401) {
      return new PackIntegrationError(
        `${what}: Der API-Schlüssel wurde abgelehnt (HTTP 401). Bitte in UniFi Network unter ` +
          `Einstellungen → Control Plane → Integrationen einen neuen Schlüssel erzeugen und hier hinterlegen.`,
        status,
      );
    }
    if (status === 403) {
      return new PackIntegrationError(
        `${what}: Zugriff verweigert (HTTP 403). Der Schlüssel ist gültig, darf diesen Standort aber nicht lesen.`,
        status,
      );
    }
    if (status === 404) {
      return new PackIntegrationError(
        `${what}: Endpunkt nicht gefunden (HTTP 404) auf ${this.host}. Diese Integration benötigt UniFi OS mit der ` +
          `Network-Integration-API unter ${API_PREFIX}; ältere Controller ohne UniFi OS werden nicht unterstützt.`,
        status,
      );
    }
    if (status === 429) {
      return new PackIntegrationError(`${what}: Zu viele Anfragen (HTTP 429). Bitte später erneut versuchen.`, status);
    }
    return new PackIntegrationError(`${what}: HTTP ${status} von ${this.host}.`, status);
  }
}

interface RawPage<T> {
  data?: T[];
  totalCount?: unknown;
}

interface RawSite {
  id?: unknown;
  name?: unknown;
  internalReference?: unknown;
}

interface RawDevice {
  id?: unknown;
  name?: unknown;
  model?: unknown;
  macAddress?: unknown;
  ipAddress?: unknown;
  state?: unknown;
  firmwareVersion?: unknown;
  firmwareUpdatable?: unknown;
}

interface RawClient {
  id?: unknown;
  name?: unknown;
  type?: unknown;
  macAddress?: unknown;
  ipAddress?: unknown;
  connectedAt?: unknown;
  uplinkDeviceId?: unknown;
  access?: unknown;
}

/**
 * States that mean "seen but not yet a member of this site".
 *
 * The endpoint is *List Adopted Devices*, so everything it returns is adopted
 * — except a device caught mid-adoption, which the state enum still reports.
 */
const UNADOPTED_STATES = new Set(["PENDING_ADOPTION", "ADOPTING"]);

function toSite(row: RawSite): UnifiSite {
  return {
    id: str(row.id),
    name: str(row.name),
    internalReference: str(row.internalReference),
  };
}

function toDevice(row: RawDevice): UnifiDevice {
  const state = optStr(row.state) ?? "UNKNOWN";
  return {
    id: str(row.id),
    name: str(row.name),
    model: str(row.model),
    macAddress: str(row.macAddress),
    state,
    adopted: !UNADOPTED_STATES.has(state),
    ipAddress: optStr(row.ipAddress),
    firmwareVersion: optStr(row.firmwareVersion),
    firmwareUpdatable: typeof row.firmwareUpdatable === "boolean" ? row.firmwareUpdatable : undefined,
  };
}

/** `type` is the OpenAPI discriminator: WIRED, WIRELESS, VPN, TELEPORT. */
function toClient(row: RawClient): UnifiClient {
  const type = (optStr(row.type) ?? "").toUpperCase();
  const connection: UnifiClientConnection =
    type === "WIRED"
      ? "wired"
      : type === "WIRELESS"
        ? "wireless"
        : type === "VPN"
          ? "vpn"
          : type === "TELEPORT"
            ? "teleport"
            : "unknown";
  const access = isRecord(row.access) ? optStr(row.access.type) : undefined;
  return {
    id: str(row.id),
    name: str(row.name),
    connection,
    // Only WIRED/WIRELESS answer the wired question at all; a VPN connection
    // is neither, and reporting `false` would file it as wireless.
    wired: connection === "wired" ? true : connection === "wireless" ? false : undefined,
    macAddress: optStr(row.macAddress),
    ipAddress: optStr(row.ipAddress),
    connectedAt: optStr(row.connectedAt),
    accessType: access,
    uplinkDeviceId: optStr(row.uplinkDeviceId),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optStr(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Host only, so an error message names the console without carrying a path or query. */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}
