/**
 * IronCrew — what a marketplace source is.
 *
 * A source is anything IronCrew can ask "what can I install from you?" and
 * that answers with a flat list of {@link MarketplaceEntry}. Four kinds ship
 * today (generic catalog, the official MCP registry, a Claude-Code
 * marketplace, a Git repository), and they differ only in how they parse
 * someone else's JSON — everything downstream of `fetchEntries` sees the same
 * shape.
 *
 * Two rules hold for every adapter:
 *
 *   1. **Nothing an adapter returns is trusted.** A catalog is a third party's
 *      JSON; it names commands IronCrew would otherwise spawn. Adapters
 *      normalise and describe, they never install, and the install path
 *      validates every entry again through `McpServerConfigSchema` (which
 *      rejects shell metacharacters) before anything is written.
 *
 *   2. **Every fetch is SSRF-guarded.** The URL comes from an admin, but an
 *      admin pointing at `169.254.169.254` by mistake must not turn IronCrew
 *      into a metadata proxy — so the default `fetchImpl` is `safeFetch`,
 *      which resolves and pins the address.
 */

import { safeFetch } from "../../security/safe-fetch.ts";

export const MARKETPLACE_KINDS = ["catalog", "mcp-registry", "claude-plugin", "git"] as const;
export type MarketplaceKind = (typeof MARKETPLACE_KINDS)[number];

export const MARKETPLACE_ENTRY_TYPES = ["mcp", "skill"] as const;
export type MarketplaceEntryType = (typeof MARKETPLACE_ENTRY_TYPES)[number];

/** How to run an MCP server, in the shape `McpServerConfigSchema` expects. */
export interface McpInstallSpec {
  transport: "stdio" | "sse";
  command?: string;
  args?: string[];
  /**
   * Environment variables the server needs. Values here are placeholders or
   * defaults from the catalog — never secrets. A real credential is supplied
   * at install time by the admin.
   */
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

/** Where a skill's content comes from. Exactly one of these is set. */
export interface SkillInstallSpec {
  /** "owner/repo", installed through the existing `skills` learn flow. */
  repo?: string;
  /** A URL serving the skill's Markdown directly. */
  contentUrl?: string;
  /** Literal Markdown, for catalogs that inline short skills. */
  content?: string;
}

/** One installable thing, normalised across all four source kinds. */
export interface MarketplaceEntry {
  /** Stable within its source — used to install and to recognise updates. */
  id: string;
  type: MarketplaceEntryType;
  /** The name the artefact gets locally (MCP server name / skill directory). */
  name: string;
  title: string;
  description: string;
  version: string;
  homepage: string;
  /** Where the artefact itself lives — the repo, package, or endpoint. */
  sourceUrl: string;
  mcp?: McpInstallSpec;
  skill?: SkillInstallSpec;
}

/** The stored source row, as much of it as an adapter needs. */
export interface MarketplaceSourceConfig {
  id: string;
  kind: MarketplaceKind;
  name: string;
  url: string;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface MarketplaceSource {
  readonly kind: MarketplaceKind;
  /**
   * Read the source and return what it offers. Throws
   * {@link MarketplaceSourceError} when the source is unreachable or its
   * payload is not the shape this adapter understands.
   */
  fetchEntries(config: MarketplaceSourceConfig): Promise<MarketplaceEntry[]>;
}

export class MarketplaceSourceError extends Error {
  constructor(
    message: string,
    readonly kind: MarketplaceKind,
  ) {
    super(message);
    this.name = "MarketplaceSourceError";
  }
}

/** Default transport for every adapter: DNS-pinned, SSRF-guarded fetch. */
export const defaultMarketplaceFetch: FetchLike = (url, init) => safeFetch(url, init);

/**
 * A catalog can serve any number of entries; a source that returns tens of
 * thousands would stall the UI and the store alike. Adapters cut the list
 * here rather than each inventing its own limit.
 */
export const MAX_ENTRIES_PER_SOURCE = 500;

/** Reads a JSON body, turning every failure mode into one legible error. */
export async function fetchJson(
  url: string,
  kind: MarketplaceKind,
  fetchImpl: FetchLike,
  init?: RequestInit,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      ...init,
      headers: { accept: "application/json", ...(init?.headers ?? {}) },
    });
  } catch (err) {
    throw new MarketplaceSourceError(
      `${url} is not reachable: ${err instanceof Error ? err.message : String(err)}`,
      kind,
    );
  }
  if (!res.ok) {
    throw new MarketplaceSourceError(`${url} answered ${res.status} ${res.statusText}`.trim(), kind);
  }
  try {
    return await res.json();
  } catch {
    throw new MarketplaceSourceError(`${url} did not answer with JSON`, kind);
  }
}

/** Reads a text body (skill Markdown, a raw manifest). */
export async function fetchText(url: string, kind: MarketplaceKind, fetchImpl: FetchLike): Promise<string> {
  let res: Response;
  try {
    res = await fetchImpl(url);
  } catch (err) {
    throw new MarketplaceSourceError(
      `${url} is not reachable: ${err instanceof Error ? err.message : String(err)}`,
      kind,
    );
  }
  if (!res.ok) {
    throw new MarketplaceSourceError(`${url} answered ${res.status} ${res.statusText}`.trim(), kind);
  }
  return await res.text();
}

/**
 * Names must survive being used as an MCP server name and as a directory
 * name, so anything outside `[a-z0-9_-]` is folded away here rather than
 * being rejected — a catalog naming a server "GitHub MCP!" is not broken,
 * just differently spelled.
 */
export function normaliseName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** Truncates free text from a third party to something a UI can hold. */
export function trimText(raw: unknown, max = 500): string {
  if (typeof raw !== "string") return "";
  const collapsed = raw.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

export function asString(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

export function asStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string");
}

export function asStringRecord(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}
