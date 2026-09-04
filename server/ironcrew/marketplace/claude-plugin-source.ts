/**
 * IronCrew — a Claude-Code plugin marketplace.
 *
 * The format Claude Code uses: a repository carrying
 * `.claude-plugin/marketplace.json`
 *
 *   { "name": "acme-plugins",
 *     "owner": { "name": "Acme" },
 *     "plugins": [ { "name": "pr-review",
 *                    "source": "./plugins/pr-review",
 *                    "description": "…", "version": "0.3.0",
 *                    "mcpServers": { "linear": { "command": "npx", … } } } ] }
 *
 * The source URL may point either at the manifest itself or at the repository
 * holding it — pointing an admin at a raw.githubusercontent.com URL when they
 * have the repo link in their clipboard is needless friction, so the repo form
 * is resolved here (GitHub and GitLab, `main` then `master`).
 *
 * How a plugin maps onto what IronCrew installs:
 *
 *  - the plugin itself becomes a **skill** entry, installed from its repo
 *    through the existing skill-learning flow;
 *  - each server under `mcpServers` becomes its own **mcp** entry, so an
 *    admin approves each server on its own rather than accepting a bundle
 *    sight unseen.
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

const MANIFEST_PATH = ".claude-plugin/marketplace.json";

type Record_ = Record<string, unknown>;

function obj(raw: unknown): Record_ | null {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record_) : null;
}

/**
 * The URLs to try, in order. A direct manifest URL is used as given; a repo
 * URL is expanded into the raw-content URLs for the usual default branches.
 */
export function manifestCandidates(rawUrl: string): string[] {
  const url = rawUrl.trim().replace(/\/+$/, "");
  if (url.endsWith(".json")) return [url];

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [url];
  }

  const host = parsed.hostname.toLowerCase();
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length < 2) return [`${url}/${MANIFEST_PATH}`];
  const [owner, repoRaw] = segments;
  const repo = repoRaw.replace(/\.git$/, "");

  if (host === "github.com" || host === "www.github.com") {
    return ["main", "master"].map(
      (ref) => `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${MANIFEST_PATH}`,
    );
  }
  if (host === "gitlab.com" || host === "www.gitlab.com") {
    return ["main", "master"].map((ref) => `https://gitlab.com/${owner}/${repo}/-/raw/${ref}/${MANIFEST_PATH}`);
  }
  return [`${url}/${MANIFEST_PATH}`];
}

/** The repository a plugin's content comes from, in "owner/repo" form. */
function repoOf(plugin: Record_, sourceUrl: string): string {
  const source = plugin.source;
  if (typeof source === "string") {
    // "./plugins/x" is a path inside the marketplace repo; "owner/repo" is
    // a repository of its own.
    if (/^[\w.-]+\/[\w.-]+$/.test(source) && !source.startsWith(".")) return source;
  } else {
    const s = obj(source);
    const repo = s ? asString(s.repo) : "";
    if (repo) return repo;
  }
  // Fall back to the marketplace's own repository.
  const match =
    /github\.com\/([\w.-]+)\/([\w.-]+)/.exec(sourceUrl) ?? /gitlab\.com\/([\w.-]+)\/([\w.-]+)/.exec(sourceUrl);
  return match ? `${match[1]}/${match[2].replace(/\.git$/, "")}` : "";
}

function mcpEntriesOf(plugin: Record_, pluginName: string, homepage: string, sourceUrl: string): MarketplaceEntry[] {
  const servers = obj(plugin.mcpServers);
  if (!servers) return [];

  const out: MarketplaceEntry[] = [];
  for (const [rawName, rawConfig] of Object.entries(servers)) {
    const config = obj(rawConfig);
    if (!config) continue;
    const name = normaliseName(rawName);
    if (!name) continue;

    const command = asString(config.command);
    const url = asString(config.url);
    if (!command && !url) continue;

    out.push({
      id: `${pluginName}:mcp:${name}`,
      type: "mcp",
      name,
      title: `${rawName} (${pluginName})`,
      description: trimText(config.description) || `MCP-Server aus dem Plugin "${pluginName}".`,
      version: trimText(plugin.version, 40),
      homepage,
      sourceUrl,
      mcp: command
        ? { transport: "stdio", command, args: asStringArray(config.args), env: asStringRecord(config.env) }
        : { transport: "sse", url, headers: asStringRecord(config.headers) },
    });
  }
  return out;
}

export class ClaudePluginMarketplaceSource implements MarketplaceSource {
  readonly kind = "claude-plugin" as const;

  constructor(private readonly fetchImpl: FetchLike = defaultMarketplaceFetch) {}

  async fetchEntries(config: MarketplaceSourceConfig): Promise<MarketplaceEntry[]> {
    const candidates = manifestCandidates(config.url);

    let manifest: Record_ | null = null;
    let lastError: unknown = null;
    for (const candidate of candidates) {
      try {
        manifest = obj(await fetchJson(candidate, this.kind, this.fetchImpl));
        if (manifest) break;
      } catch (err) {
        lastError = err;
      }
    }
    if (!manifest) {
      const detail = lastError instanceof Error ? lastError.message : candidates.join(", ");
      throw new MarketplaceSourceError(`No ${MANIFEST_PATH} found: ${detail}`, this.kind);
    }

    const plugins = Array.isArray(manifest.plugins) ? manifest.plugins : [];
    if (plugins.length === 0) {
      throw new MarketplaceSourceError(`${config.url} carries no "plugins" array`, this.kind);
    }

    const entries: MarketplaceEntry[] = [];
    const seen = new Set<string>();
    for (const raw of plugins) {
      const plugin = obj(raw);
      if (!plugin) continue;
      const name = normaliseName(asString(plugin.name));
      if (!name) continue;

      const homepage = asString(plugin.homepage);
      const repo = repoOf(plugin, config.url);
      const sourceUrl = repo ? `https://github.com/${repo}` : homepage || config.url;

      const keywords = asStringArray(plugin.keywords);
      const candidatesForEntry: MarketplaceEntry[] = [
        {
          id: `${name}`,
          type: "skill",
          name,
          title: trimText(plugin.name, 120) || name,
          description:
            trimText(plugin.description) || (keywords.length > 0 ? `Schlagworte: ${keywords.join(", ")}` : ""),
          version: trimText(plugin.version, 40),
          homepage,
          sourceUrl,
          skill: repo ? { repo } : { contentUrl: sourceUrl },
        },
        ...mcpEntriesOf(plugin, name, homepage, sourceUrl),
      ];

      for (const entry of candidatesForEntry) {
        const key = `${entry.type}:${entry.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push(entry);
        if (entries.length >= MAX_ENTRIES_PER_SOURCE) return entries;
      }
    }
    return entries;
  }
}
