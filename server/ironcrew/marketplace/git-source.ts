/**
 * IronCrew — a Git repository as its own marketplace.
 *
 * Not every useful thing is listed in a catalog. This source treats one
 * repository as the offer: an admin pastes `https://github.com/acme/pr-review`
 * and gets exactly what that repo contains, nothing else.
 *
 * What it looks for, in order — the repo decides, IronCrew does not guess:
 *
 *   1. `.mcp.json` at the root (the format Claude Code projects use):
 *      every server declared there becomes its own **mcp** entry.
 *   2. `.claude-plugin/plugin.json`: its name/description/version describe
 *      the repository better than the URL does.
 *   3. The repository itself always yields one **skill** entry, installed
 *      through the existing skill-learning flow (`owner/repo`).
 *
 * Steps 1 and 2 are best-effort: a repository without those files is normal
 * and still installable as a skill, so a 404 there is not an error.
 */

import {
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

type Record_ = Record<string, unknown>;

function obj(raw: unknown): Record_ | null {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record_) : null;
}

export interface GitRepoRef {
  owner: string;
  repo: string;
  /** Base URL for raw file content, without a trailing slash. */
  rawBase: string;
  webUrl: string;
}

/**
 * Parses the repository forms an admin actually pastes: a browser URL, an
 * `owner/repo` shorthand, or a clone URL ending in `.git`.
 */
export function parseGitRepo(rawUrl: string): GitRepoRef | null {
  const trimmed = rawUrl.trim().replace(/\/+$/, "");
  if (!trimmed) return null;

  if (/^[\w.-]+\/[\w.-]+$/.test(trimmed)) {
    const [owner, repoRaw] = trimmed.split("/");
    const repo = repoRaw.replace(/\.git$/, "");
    return {
      owner,
      repo,
      rawBase: `https://raw.githubusercontent.com/${owner}/${repo}`,
      webUrl: `https://github.com/${owner}/${repo}`,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed.replace(/^git@([^:]+):/, "https://$1/"));
  } catch {
    return null;
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/, "");
  const host = parsed.hostname.toLowerCase();

  if (host.endsWith("gitlab.com")) {
    return {
      owner,
      repo,
      rawBase: `https://gitlab.com/${owner}/${repo}/-/raw`,
      webUrl: `https://gitlab.com/${owner}/${repo}`,
    };
  }
  return {
    owner,
    repo,
    rawBase: `https://raw.githubusercontent.com/${owner}/${repo}`,
    webUrl: `https://github.com/${owner}/${repo}`,
  };
}

export class GitMarketplaceSource implements MarketplaceSource {
  readonly kind = "git" as const;

  constructor(private readonly fetchImpl: FetchLike = defaultMarketplaceFetch) {}

  /** Best-effort read: a missing optional file is `null`, never a throw. */
  private async optionalJson(urls: string[]): Promise<Record_ | null> {
    for (const url of urls) {
      try {
        const payload = obj(await fetchJson(url, this.kind, this.fetchImpl));
        if (payload) return payload;
      } catch {
        // Next branch, next file, or none at all.
      }
    }
    return null;
  }

  async fetchEntries(config: MarketplaceSourceConfig): Promise<MarketplaceEntry[]> {
    const ref = parseGitRepo(config.url);
    if (!ref) {
      throw new MarketplaceSourceError(
        `"${config.url}" is not a repository URL (expected e.g. https://github.com/owner/repo or owner/repo)`,
        this.kind,
      );
    }

    const branches = ["main", "master"];
    const at = (file: string) => branches.map((branch) => `${ref.rawBase}/${branch}/${file}`);

    const plugin = await this.optionalJson(at(".claude-plugin/plugin.json"));
    const skillName = normaliseName(asString(plugin?.name) || ref.repo);

    const entries: MarketplaceEntry[] = [
      {
        id: `${ref.owner}/${ref.repo}`,
        type: "skill",
        name: skillName,
        title: trimText(plugin?.name, 120) || ref.repo,
        description: trimText(plugin?.description) || `Skill aus dem Repository ${ref.owner}/${ref.repo}.`,
        version: trimText(plugin?.version, 40),
        homepage: ref.webUrl,
        sourceUrl: ref.webUrl,
        skill: { repo: `${ref.owner}/${ref.repo}` },
      },
    ];

    const mcpFile = await this.optionalJson(at(".mcp.json"));
    const servers = obj(mcpFile?.mcpServers) ?? (mcpFile && !mcpFile.mcpServers ? mcpFile : null);
    if (servers) {
      for (const [rawName, rawConfig] of Object.entries(servers)) {
        const server = obj(rawConfig);
        if (!server) continue;
        const name = normaliseName(rawName);
        if (!name) continue;
        const command = asString(server.command);
        const url = asString(server.url);
        if (!command && !url) continue;

        entries.push({
          id: `${ref.owner}/${ref.repo}:mcp:${name}`,
          type: "mcp",
          name,
          title: `${rawName} (${ref.repo})`,
          description: trimText(server.description) || `MCP-Server aus ${ref.owner}/${ref.repo}.`,
          version: trimText(plugin?.version, 40),
          homepage: ref.webUrl,
          sourceUrl: ref.webUrl,
          mcp: command
            ? { transport: "stdio", command, args: asStringArray(server.args), env: asStringRecord(server.env) }
            : { transport: "sse", url, headers: asStringRecord(server.headers) },
        });
      }
    }

    return entries;
  }
}
