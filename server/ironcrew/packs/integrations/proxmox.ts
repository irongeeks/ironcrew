/**
 * IronCrew — Proxmox VE integration adapter.
 *
 * WHY THIS ADAPTER EXISTS
 *
 * The MSP pack's whole premise is that an operator should be able to ask
 * "what is running, and where" without opening a second browser tab and
 * logging into a hypervisor by hand. Proxmox is the cluster most of our
 * target shops actually run, and the three questions they ask it in the
 * morning are always the same three: is it reachable, are the nodes healthy,
 * which guests are down. That is exactly `testConnection()`, `listNodes()`
 * and `listGuests()` — nothing more.
 *
 * WHY IT IS READ-ONLY, AND STAYS READ-ONLY
 *
 * There is no start, stop, migrate, snapshot or delete here, and adding one
 * is not a small follow-up commit. A Proxmox token that can start and stop
 * VMs is a token that can take a customer offline — the blast radius of a
 * confused agent holding it is the customer's production, not a bad answer in
 * a chat window. Read-only is also what the tool registry classes as risk
 * "read" (`packToolSchema.risk_class`), so the classification an owner sees
 * when granting the tool matches what the code can physically do. A write
 * method here would silently make that label a lie.
 *
 * WHY /cluster/resources FOR GUESTS
 *
 * `GET /cluster/resources?type=vm` answers for the whole cluster in one call
 * and returns QEMU VMs and LXC containers together, distinguished by their
 * `type` field. Walking `/nodes/{node}/qemu` plus `/nodes/{node}/lxc` would be
 * 2n calls, would race with a live migration (a guest can appear twice or not
 * at all), and would need error handling for a node that is down. A
 * standalone Proxmox host is a cluster of one, so this path works there too.
 *
 * API AS PUBLISHED — NOTHING HERE IS INVENTED
 *
 *   https://pve.proxmox.com/wiki/Proxmox_VE_API
 *   (per-endpoint reference: https://pve.proxmox.com/pve-docs/api-viewer/)
 *
 * From that documentation: the base URL is `https://host:8006/api2/json/`,
 * and an API token authenticates with the header
 * `Authorization: PVEAPIToken=USER@REALM!TOKENID=SECRET`. The endpoints used
 * are `/version`, `/nodes` and `/cluster/resources?type=vm`.
 *
 * WHAT IS NOT CONFIRMED
 *
 * The documented *field lists* of `/nodes` and `/cluster/resources` are
 * looser than their real responses: fields such as `uptime` or `name` are
 * absent for an offline node or a nameless guest, and Proxmox has added
 * fields between minor releases. So every field is read defensively and
 * mapped to `null` rather than assumed — see `finiteNumber()`. This adapter
 * has never run against a live cluster from this repository; its tests assert
 * the request it builds and the mapping it performs, which is a real
 * guarantee and not the same guarantee. `testConnection()` is what an
 * operator runs on day one to find out.
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

export interface ProxmoxAdapterOptions extends HttpIntegrationOptions {
  /**
   * The token's id, `USER@REALM!TOKENID` — the part *before* the "=" in the
   * header. Proxmox prints it as one string when the token is created.
   */
  tokenId: string;
  /** The token's secret (a UUID). Never logged, never put in a message. */
  tokenSecret: string;
}

export interface ProxmoxNode {
  /** Proxmox calls this `node`; it is the hostname within the cluster. */
  name: string;
  /** "online", "offline" or "unknown" as Proxmox reports it. */
  status: string;
  /** Current load as a fraction of all cores, 0…1 — not a percentage. */
  cpuUsage: number | null;
  /** Core count, so a caller can turn `cpuUsage` into something absolute. */
  cpuCores: number | null;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
  uptimeSeconds: number | null;
}

/** Proxmox's own two words for a guest: a full VM, or a container. */
export type ProxmoxGuestType = "qemu" | "lxc";

export interface ProxmoxGuest {
  vmid: number;
  name: string;
  node: string;
  type: ProxmoxGuestType;
  /** "running", "stopped", … as Proxmox reports it. */
  status: string;
  /**
   * Templates are listed alongside real guests and always read "stopped".
   * Without this flag an operator's "why is that VM down" list is wrong on
   * every cluster that uses templates, which is most of them.
   */
  template: boolean;
}

/** `GET /api2/json/version` → `{ version, release, repoid }`. */
interface ProxmoxVersion {
  version?: unknown;
  release?: unknown;
}

interface ProxmoxNodeRow {
  node?: unknown;
  status?: unknown;
  cpu?: unknown;
  maxcpu?: unknown;
  mem?: unknown;
  maxmem?: unknown;
  uptime?: unknown;
}

interface ProxmoxResourceRow {
  vmid?: unknown;
  name?: unknown;
  node?: unknown;
  type?: unknown;
  status?: unknown;
  template?: unknown;
}

export class ProxmoxAdapter implements PackIntegrationAdapter {
  readonly key = "proxmox";
  readonly label = "Proxmox VE";

  private readonly baseUrl: string;
  private readonly tokenId: string;
  private readonly tokenSecret: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number | undefined;

  constructor(opts: ProxmoxAdapterOptions) {
    this.baseUrl = normaliseBaseUrl(opts.baseUrl);
    this.tokenId = (opts.tokenId ?? "").trim();
    this.tokenSecret = (opts.tokenSecret ?? "").trim();
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs;
  }

  /**
   * Reachability and auth, reported rather than thrown.
   *
   * `/version` is the cheapest authenticated call Proxmox has: it needs a
   * valid token but no privilege on any object, so a green answer here means
   * "host up, token accepted" and nothing else — a red `listNodes()` after a
   * green probe is then unambiguously a permissions problem.
   */
  async testConnection(): Promise<IntegrationStatus> {
    try {
      const data = await this.request<ProxmoxVersion>("/version", "Proxmox-Version");
      const version = typeof data?.version === "string" ? data.version : undefined;
      return {
        ok: true,
        message: version
          ? `Proxmox VE ${version} erreichbar, API-Token akzeptiert.`
          : "Proxmox VE erreichbar, API-Token akzeptiert (Version nicht gemeldet).",
        version,
      };
    } catch (err) {
      return { ok: false, message: errorText(err) };
    }
  }

  /** The cluster's nodes with the health numbers an operator reads first. */
  async listNodes(): Promise<ProxmoxNode[]> {
    const rows = await this.request<ProxmoxNodeRow[]>("/nodes", "Knotenliste");
    return asArray<ProxmoxNodeRow>(rows).map((row) => ({
      name: text(row.node) ?? "unbekannt",
      status: text(row.status) ?? "unbekannt",
      cpuUsage: finiteNumber(row.cpu),
      cpuCores: finiteNumber(row.maxcpu),
      memoryUsedBytes: finiteNumber(row.mem),
      memoryTotalBytes: finiteNumber(row.maxmem),
      uptimeSeconds: finiteNumber(row.uptime),
    }));
  }

  /** Every VM and container in the cluster, in one call. */
  async listGuests(): Promise<ProxmoxGuest[]> {
    const rows = await this.request<ProxmoxResourceRow[]>("/cluster/resources?type=vm", "Gastliste");
    const guests: ProxmoxGuest[] = [];
    for (const row of asArray<ProxmoxResourceRow>(rows)) {
      const type = row.type === "qemu" || row.type === "lxc" ? row.type : undefined;
      const vmid = finiteNumber(row.vmid);
      // A row without a type or a vmid is not a guest we can act on, and a
      // future Proxmox release adding a third resource type under `type=vm`
      // should be ignored here rather than mapped into a wrong shape.
      if (type === undefined || vmid === null) continue;
      guests.push({
        vmid,
        // Nameless guests exist (a VM created via the API without `name`);
        // the vmid is the only identifier that is always present.
        name: text(row.name) ?? String(vmid),
        node: text(row.node) ?? "unbekannt",
        type,
        status: text(row.status) ?? "unbekannt",
        template: row.template === 1 || row.template === true,
      });
    }
    return guests;
  }

  /**
   * `Authorization: PVEAPIToken=USER@REALM!TOKENID=SECRET`.
   *
   * Built per request and never stored anywhere a logger could reach. The
   * shape check is here rather than in the constructor because a
   * misconfigured token must reach the operator through `testConnection()`'s
   * report, not as an exception thrown while the Settings page renders.
   */
  private authorization(): string {
    if (this.tokenId === "" || this.tokenSecret === "") {
      throw new PackIntegrationError("Der Proxmox-API-Token ist nicht konfiguriert (Token-ID und Secret fehlen).");
    }
    if (!this.tokenId.includes("@") || !this.tokenId.includes("!")) {
      // Naming the expected *shape* is safe; echoing the value is not, and
      // the token id is half of the credential.
      throw new PackIntegrationError('Die Proxmox-Token-ID muss die Form "USER@REALM!TOKENID" haben.');
    }
    return `PVEAPIToken=${this.tokenId}=${this.tokenSecret}`;
  }

  /** One authenticated GET against `/api2/json`, unwrapped from `{ data }`. */
  private async request<T>(path: string, what: string): Promise<T> {
    const url = `${this.baseUrl}/api2/json${path}`;
    const res = await integrationFetch(
      this.fetchImpl,
      url,
      { method: "GET", headers: { Accept: "application/json", Authorization: this.authorization() } },
      this.timeoutMs,
    );
    if (!res.ok) {
      // Deliberately no response body: Proxmox echoes the failing request in
      // some error paths, and that request carried the token.
      throw new PackIntegrationError(`${what}: ${describeStatus(res.status, url)}`, res.status);
    }
    const body = await integrationJson<{ data?: unknown }>(res, what);
    if (body?.data === undefined || body.data === null) {
      throw new PackIntegrationError(
        `${what}: die Antwort enthielt kein "data"-Feld (HTTP ${res.status}).`,
        res.status,
      );
    }
    return body.data as T;
  }
}

/**
 * What an operator can act on, per status.
 *
 * 401 and 403 are the two failures that look identical in a log and need
 * opposite fixes: 401 is "this token is not valid" (wrong id, wrong secret,
 * token deleted), 403 is "this token is valid but may not see this" — which
 * on Proxmox almost always means the role PVEAuditor was never granted on /.
 */
function describeStatus(status: number, url: string): string {
  if (status === 401) {
    return "Der API-Token wurde nicht akzeptiert (HTTP 401). Token-ID und Secret prüfen — der Token ist ungültig, abgelaufen oder gelöscht.";
  }
  if (status === 403) {
    return "Der API-Token ist gültig, hat aber keine Berechtigung für diesen Aufruf (HTTP 403). Dem Token fehlt vermutlich die Rolle PVEAuditor auf / (Audit-Recht).";
  }
  if (status === 404) {
    return `Endpunkt nicht gefunden (HTTP 404): ${url}. Zeigt die Basis-URL wirklich auf die Proxmox-Weboberfläche (Port 8006)?`;
  }
  if (status >= 500) {
    return `Proxmox hat mit HTTP ${status} geantwortet (${url}). Das ist ein Fehler auf dem Server, nicht in der Konfiguration.`;
  }
  return `Unerwartete Antwort HTTP ${status} von ${url}.`;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/** Proxmox omits fields it has no value for; "absent" is not "zero". */
function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
