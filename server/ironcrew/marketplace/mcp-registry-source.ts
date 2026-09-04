/**
 * IronCrew — the official MCP registry (registry.modelcontextprotocol.io).
 *
 * `GET <base>/v0/servers` answers with a page of server records and a cursor:
 *
 *   { "servers": [ { "name": "io.github.owner/thing",
 *                    "description": "…", "version": "1.2.0",
 *                    "repository": { "url": "https://github.com/…" },
 *                    "packages": [ { "registryType": "npm",
 *                                    "identifier": "@owner/thing",
 *                                    "transport": { "type": "stdio" },
 *                                    "environmentVariables": [ … ] } ],
 *                    "remotes":  [ { "type": "sse", "url": "https://…" } ] } ],
 *     "metadata": { "nextCursor": "…" } }
 *
 * Newer responses wrap each record as `{ "server": { … }, "_meta": { … } }`;
 * both shapes are read.
 *
 * Two honest limitations, rather than a convenient lie:
 *
 *  - IronCrew's MCP connector speaks stdio and SSE (see mcp-connector.ts).
 *    A server offered *only* over streamable-http is therefore not listed —
 *    labelling it "sse" would produce an entry that installs and then never
 *    connects.
 *  - `environmentVariables` become **empty** placeholders. The registry
 *    describes which variables a server needs; it never carries their values,
 *    and IronCrew does not invent them. The admin fills them in at install.
 */

import {
  MAX_ENTRIES_PER_SOURCE,
  MarketplaceSourceError,
  asString,
  defaultMarketplaceFetch,
  fetchJson,
  normaliseName,
  trimText,
  type FetchLike,
  type MarketplaceEntry,
  type MarketplaceSource,
  type MarketplaceSourceConfig,
  type McpInstallSpec,
} from "./marketplace-source.ts";

const PAGE_SIZE = 100;
/** A guard against paging forever if a registry keeps handing out cursors. */
const MAX_PAGES = 10;

type Record_ = Record<string, unknown>;

function obj(raw: unknown): Record_ | null {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record_) : null;
}

function arr(raw: unknown): unknown[] {
  return Array.isArray(raw) ? raw : [];
}

/**
 * Turns a package record into a runnable command. The registry says which
 * ecosystem a package lives in, not how to run it, so the mapping lives here.
 */
function commandFor(pkg: Record_): { command: string; args: string[] } | null {
  const registryType = asString(pkg.registryType) || asString(pkg.registry_name);
  const identifier = asString(pkg.identifier) || asString(pkg.name);
  if (!identifier) return null;
  const version = asString(pkg.version);

  switch (registryType) {
    case "npm":
      return { command: "npx", args: ["-y", version ? `${identifier}@${version}` : identifier] };
    case "pypi":
      return { command: "uvx", args: [version ? `${identifier}==${version}` : identifier] };
    case "nuget":
      return { command: "dnx", args: [identifier, "--yes"] };
    default:
      // oci/docker and anything new: IronCrew would have to guess at run
      // flags, mounts and networking. Skipped rather than guessed.
      return null;
  }
}

/** Extra CLI arguments the registry attaches to a package. */
function extraArgs(pkg: Record_): string[] {
  const out: string[] = [];
  for (const raw of [...arr(pkg.runtimeArguments), ...arr(pkg.packageArguments)]) {
    const a = obj(raw);
    if (!a) continue;
    const name = asString(a.name);
    const value = asString(a.value) || asString(a.default);
    if (asString(a.type) === "named" && name) {
      out.push(name);
      if (value) out.push(value);
    } else if (value) {
      out.push(value);
    }
  }
  return out;
}

/** Declared environment variables, as empty placeholders (never values). */
function envPlaceholders(pkg: Record_): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of arr(pkg.environmentVariables)) {
    const v = obj(raw);
    const name = v ? asString(v.name) : "";
    if (name) env[name] = "";
  }
  return env;
}

function specFor(server: Record_): McpInstallSpec | null {
  for (const raw of arr(server.packages)) {
    const pkg = obj(raw);
    if (!pkg) continue;
    const transportType = asString(obj(pkg.transport)?.type) || "stdio";
    if (transportType !== "stdio") continue;
    const cmd = commandFor(pkg);
    if (!cmd) continue;
    return {
      transport: "stdio",
      command: cmd.command,
      args: [...cmd.args, ...extraArgs(pkg)],
      env: envPlaceholders(pkg),
    };
  }

  for (const raw of arr(server.remotes)) {
    const remote = obj(raw);
    if (!remote) continue;
    // Only SSE — see the note at the top of this file.
    if (asString(remote.type) !== "sse") continue;
    const url = asString(remote.url);
    if (!url) continue;
    return { transport: "sse", url, headers: {} };
  }

  return null;
}

function toEntry(raw: unknown): MarketplaceEntry | null {
  const wrapper = obj(raw);
  if (!wrapper) return null;
  // Newer responses nest the record under "server"; older ones are flat.
  const server = obj(wrapper.server) ?? wrapper;

  const fullName = asString(server.name);
  if (!fullName) return null;
  // Registry names are reverse-DNS ("io.github.owner/thing"); the last
  // segment is what an admin recognises and what the server is called locally.
  const shortName = normaliseName(fullName.split("/").pop() ?? fullName);
  if (!shortName) return null;

  const mcp = specFor(server);
  if (!mcp) return null;

  return {
    id: fullName,
    type: "mcp",
    name: shortName,
    title: trimText(fullName, 120),
    description: trimText(server.description),
    version: trimText(server.version, 40),
    homepage: asString(obj(server.repository)?.url),
    sourceUrl: asString(obj(server.repository)?.url) || fullName,
    mcp,
  };
}

export class McpRegistryMarketplaceSource implements MarketplaceSource {
  readonly kind = "mcp-registry" as const;

  constructor(private readonly fetchImpl: FetchLike = defaultMarketplaceFetch) {}

  async fetchEntries(config: MarketplaceSourceConfig): Promise<MarketplaceEntry[]> {
    const base = config.url.replace(/\/+$/, "");
    // A URL that already names the endpoint is used as given; a bare host
    // gets the documented path appended.
    const endpoint = /\/v\d+\/servers$/.test(base) ? base : `${base}/v0/servers`;

    const entries: MarketplaceEntry[] = [];
    const seen = new Set<string>();
    let cursor = "";

    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL(endpoint);
      url.searchParams.set("limit", String(PAGE_SIZE));
      if (cursor) url.searchParams.set("cursor", cursor);

      const payload = obj(await fetchJson(url.toString(), this.kind, this.fetchImpl));
      if (!payload || !Array.isArray(payload.servers)) {
        throw new MarketplaceSourceError(
          `${endpoint} does not look like an MCP registry (no "servers" array)`,
          this.kind,
        );
      }

      for (const raw of payload.servers) {
        const entry = toEntry(raw);
        if (!entry || seen.has(entry.name)) continue;
        seen.add(entry.name);
        entries.push(entry);
        if (entries.length >= MAX_ENTRIES_PER_SOURCE) return entries;
      }

      cursor = asString(obj(payload.metadata)?.nextCursor);
      if (!cursor) break;
    }

    return entries;
  }
}
