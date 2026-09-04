/**
 * IronCrew — the generic catalog source.
 *
 * The lowest-common-denominator format, and the one anyone can host: a JSON
 * document listing what it offers. Accepted shapes, in order of preference:
 *
 *   { "entries": [ … ] }        the documented form
 *   { "items":   [ … ] }        a common alias
 *   { "servers": [ … ] }        an MCP-only catalog
 *   { "skills":  [ … ] }        a skills-only catalog
 *   [ … ]                       a bare array
 *
 * An entry names either an MCP server or a skill:
 *
 *   {
 *     "id": "github", "type": "mcp", "name": "github",
 *     "title": "GitHub", "description": "…", "version": "1.2.0",
 *     "homepage": "https://…",
 *     "mcp": { "transport": "stdio", "command": "npx",
 *              "args": ["-y", "@modelcontextprotocol/server-github"],
 *              "env": { "GITHUB_TOKEN": "" } }
 *   }
 *
 *   { "id": "pr-review", "type": "skill", "name": "pr-review",
 *     "skill": { "repo": "acme/skills" } }
 *
 * Entries that name neither are skipped rather than failing the whole sync:
 * one malformed row in someone else's catalog should not hide the other
 * hundred.
 */

import {
  MAX_ENTRIES_PER_SOURCE,
  MarketplaceSourceError,
  asString,
  asStringArray,
  asStringRecord,
  defaultMarketplaceFetch,
  fetchJson,
  normaliseName,
  trimText,
  type FetchLike,
  type MarketplaceEntry,
  type MarketplaceSource,
  type MarketplaceSourceConfig,
} from "./marketplace-source.ts";

function entryList(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  const obj = payload as Record<string, unknown>;
  for (const key of ["entries", "items", "servers", "skills"]) {
    if (Array.isArray(obj[key])) return obj[key] as unknown[];
  }
  return [];
}

function toEntry(raw: unknown, index: number): MarketplaceEntry | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;

  const mcpRaw = obj.mcp && typeof obj.mcp === "object" ? (obj.mcp as Record<string, unknown>) : null;
  const skillRaw = obj.skill && typeof obj.skill === "object" ? (obj.skill as Record<string, unknown>) : null;

  // The declared type wins; when it is missing, the payload decides. A
  // catalog listing servers under "servers" often omits "type" entirely.
  const declared = asString(obj.type);
  const type = declared === "mcp" || declared === "skill" ? declared : mcpRaw ? "mcp" : skillRaw ? "skill" : null;
  if (!type) return null;

  const name = normaliseName(asString(obj.name) || asString(obj.id) || asString(obj.title));
  if (!name) return null;

  const entry: MarketplaceEntry = {
    id: asString(obj.id) || `${name}-${index}`,
    type,
    name,
    title: trimText(obj.title, 120) || name,
    description: trimText(obj.description),
    version: trimText(obj.version, 40),
    homepage: asString(obj.homepage),
    sourceUrl: asString(obj.sourceUrl) || asString(obj.repository) || asString(obj.homepage),
  };

  if (type === "mcp") {
    if (!mcpRaw) return null;
    const transport = asString(mcpRaw.transport) === "sse" ? "sse" : "stdio";
    entry.mcp = {
      transport,
      command: asString(mcpRaw.command) || undefined,
      args: asStringArray(mcpRaw.args),
      env: asStringRecord(mcpRaw.env),
      url: asString(mcpRaw.url) || undefined,
      headers: asStringRecord(mcpRaw.headers),
    };
    // Without the field its transport needs, the entry cannot be installed —
    // surfacing it would only produce a validation error later.
    if (transport === "stdio" && !entry.mcp.command) return null;
    if (transport === "sse" && !entry.mcp.url) return null;
  } else {
    if (!skillRaw) return null;
    const repo = asString(skillRaw.repo);
    const contentUrl = asString(skillRaw.contentUrl);
    const content = typeof skillRaw.content === "string" ? skillRaw.content : "";
    if (!repo && !contentUrl && !content) return null;
    entry.skill = { repo: repo || undefined, contentUrl: contentUrl || undefined, content: content || undefined };
  }

  return entry;
}

export class CatalogMarketplaceSource implements MarketplaceSource {
  readonly kind = "catalog" as const;

  constructor(private readonly fetchImpl: FetchLike = defaultMarketplaceFetch) {}

  async fetchEntries(config: MarketplaceSourceConfig): Promise<MarketplaceEntry[]> {
    const payload = await fetchJson(config.url, this.kind, this.fetchImpl);
    const list = entryList(payload);
    if (list.length === 0) {
      throw new MarketplaceSourceError(
        `${config.url} contains no catalog entries (expected "entries", "items", "servers", "skills" or a bare array)`,
        this.kind,
      );
    }

    const seen = new Set<string>();
    const entries: MarketplaceEntry[] = [];
    for (const [index, raw] of list.entries()) {
      const entry = toEntry(raw, index);
      if (!entry) continue;
      const dedupeKey = `${entry.type}:${entry.name}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      entries.push(entry);
      if (entries.length >= MAX_ENTRIES_PER_SOURCE) break;
    }
    return entries;
  }
}
