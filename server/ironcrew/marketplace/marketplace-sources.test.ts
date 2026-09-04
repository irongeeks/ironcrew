import { describe, it, expect } from "vitest";
import { CatalogMarketplaceSource } from "./catalog-source.ts";
import { McpRegistryMarketplaceSource } from "./mcp-registry-source.ts";
import { ClaudePluginMarketplaceSource, manifestCandidates } from "./claude-plugin-source.ts";
import { GitMarketplaceSource, parseGitRepo } from "./git-source.ts";
import {
  MarketplaceSourceError,
  normaliseName,
  type FetchLike,
  type MarketplaceSourceConfig,
} from "./marketplace-source.ts";

/**
 * A fetch stub serving a fixed URL→body map. Every adapter takes its
 * transport by injection, so these tests exercise the real parsing code
 * without a socket — and record which URLs were asked for, which is itself
 * behaviour worth asserting (branch fallbacks, pagination).
 */
function stubFetch(routes: Record<string, unknown>, calls: string[] = []): FetchLike {
  return async (url: string) => {
    calls.push(url);
    const body = routes[url];
    if (body === undefined) {
      return new Response("not found", { status: 404, statusText: "Not Found" });
    }
    if (typeof body === "string") return new Response(body, { status: 200 });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
}

function config(over: Partial<MarketplaceSourceConfig> = {}): MarketplaceSourceConfig {
  return { id: "mkt_1", kind: "catalog", name: "acme", url: "https://example.com/catalog.json", ...over };
}

describe("normaliseName", () => {
  it("folds a display name into something usable as a server and directory name", () => {
    expect(normaliseName("GitHub MCP!")).toBe("github-mcp");
    expect(normaliseName("  --Weird__Name--  ")).toBe("weird__name");
    expect(normaliseName("ä")).toBe("");
  });
});

describe("CatalogMarketplaceSource", () => {
  const url = "https://example.com/catalog.json";

  it("reads MCP and skill entries from the documented shape", async () => {
    const source = new CatalogMarketplaceSource(
      stubFetch({
        [url]: {
          entries: [
            {
              id: "github",
              type: "mcp",
              name: "github",
              title: "GitHub",
              description: "Repos und Issues",
              version: "1.2.0",
              homepage: "https://example.com/github",
              mcp: { transport: "stdio", command: "npx", args: ["-y", "@x/github"], env: { TOKEN: "" } },
            },
            { id: "pr-review", type: "skill", name: "pr-review", skill: { repo: "acme/skills" } },
          ],
        },
      }),
    );

    const entries = await source.fetchEntries(config());
    expect(entries).toHaveLength(2);
    expect(entries[0].mcp).toEqual({
      transport: "stdio",
      command: "npx",
      args: ["-y", "@x/github"],
      env: { TOKEN: "" },
      url: undefined,
      headers: {},
    });
    expect(entries[1].skill).toEqual({ repo: "acme/skills", contentUrl: undefined, content: undefined });
  });

  it("accepts a bare array and the common aliases", async () => {
    const entry = { id: "a", type: "skill", name: "a", skill: { repo: "o/r" } };
    for (const payload of [[entry], { items: [entry] }, { servers: [entry] }, { skills: [entry] }]) {
      const source = new CatalogMarketplaceSource(stubFetch({ [url]: payload }));
      expect(await source.fetchEntries(config())).toHaveLength(1);
    }
  });

  it("infers the type from the payload when it is not declared", async () => {
    const source = new CatalogMarketplaceSource(
      stubFetch({ [url]: { servers: [{ name: "linear", mcp: { transport: "stdio", command: "npx" } }] } }),
    );
    const [entry] = await source.fetchEntries(config());
    expect(entry.type).toBe("mcp");
  });

  it("skips entries that could never be installed instead of failing the sync", async () => {
    const source = new CatalogMarketplaceSource(
      stubFetch({
        [url]: {
          entries: [
            { id: "ok", type: "skill", name: "ok", skill: { repo: "o/r" } },
            { id: "no-command", type: "mcp", name: "broken", mcp: { transport: "stdio" } },
            { id: "no-url", type: "mcp", name: "broken2", mcp: { transport: "sse" } },
            { id: "no-payload", type: "skill", name: "broken3" },
            "not an object",
          ],
        },
      }),
    );

    expect((await source.fetchEntries(config())).map((e) => e.name)).toEqual(["ok"]);
  });

  it("keeps the first of two entries claiming the same name and type", async () => {
    const source = new CatalogMarketplaceSource(
      stubFetch({
        [url]: {
          entries: [
            { id: "a", type: "skill", name: "dup", version: "1", skill: { repo: "o/a" } },
            { id: "b", type: "skill", name: "dup", version: "2", skill: { repo: "o/b" } },
          ],
        },
      }),
    );
    const entries = await source.fetchEntries(config());
    expect(entries).toHaveLength(1);
    expect(entries[0].version).toBe("1");
  });

  it("reports an unreachable catalog rather than pretending it is empty", async () => {
    const source = new CatalogMarketplaceSource(stubFetch({}));
    await expect(source.fetchEntries(config())).rejects.toThrow(MarketplaceSourceError);
  });

  it("reports a payload that is not a catalog", async () => {
    const source = new CatalogMarketplaceSource(stubFetch({ [url]: { hello: "world" } }));
    await expect(source.fetchEntries(config())).rejects.toThrow(/no catalog entries/);
  });
});

describe("McpRegistryMarketplaceSource", () => {
  const endpoint = "https://registry.modelcontextprotocol.io/v0/servers?limit=100";

  function registryPayload(servers: unknown[], nextCursor?: string) {
    return { servers, metadata: nextCursor ? { nextCursor } : {} };
  }

  it("turns an npm package into a runnable stdio command", async () => {
    const source = new McpRegistryMarketplaceSource(
      stubFetch({
        [endpoint]: registryPayload([
          {
            name: "io.github.acme/github-server",
            description: "GitHub",
            version: "1.4.0",
            repository: { url: "https://github.com/acme/github-server" },
            packages: [
              {
                registryType: "npm",
                identifier: "@acme/github-server",
                version: "1.4.0",
                transport: { type: "stdio" },
                environmentVariables: [{ name: "GITHUB_TOKEN", isRequired: true, isSecret: true }],
              },
            ],
          },
        ]),
      }),
    );

    const [entry] = await source.fetchEntries(
      config({ kind: "mcp-registry", url: "https://registry.modelcontextprotocol.io" }),
    );
    expect(entry.name).toBe("github-server");
    expect(entry.mcp).toMatchObject({ transport: "stdio", command: "npx", args: ["-y", "@acme/github-server@1.4.0"] });
    // The registry says which variables exist, never their values.
    expect(entry.mcp?.env).toEqual({ GITHUB_TOKEN: "" });
  });

  it("maps pypi packages to uvx", async () => {
    const source = new McpRegistryMarketplaceSource(
      stubFetch({
        [endpoint]: registryPayload([
          {
            name: "io.github.acme/py-server",
            packages: [
              { registryType: "pypi", identifier: "acme-mcp", version: "0.2.0", transport: { type: "stdio" } },
            ],
          },
        ]),
      }),
    );
    const [entry] = await source.fetchEntries(
      config({ kind: "mcp-registry", url: "https://registry.modelcontextprotocol.io" }),
    );
    expect(entry.mcp).toMatchObject({ command: "uvx", args: ["acme-mcp==0.2.0"] });
  });

  it("reads the newer records that nest the server under 'server'", async () => {
    const source = new McpRegistryMarketplaceSource(
      stubFetch({
        [endpoint]: registryPayload([
          {
            server: {
              name: "io.github.acme/nested",
              packages: [{ registryType: "npm", identifier: "@acme/nested", transport: { type: "stdio" } }],
            },
            _meta: { official: true },
          },
        ]),
      }),
    );
    expect(
      (await source.fetchEntries(config({ kind: "mcp-registry", url: "https://registry.modelcontextprotocol.io" })))[0]
        .name,
    ).toBe("nested");
  });

  it("offers an SSE remote when there is no installable package", async () => {
    const source = new McpRegistryMarketplaceSource(
      stubFetch({
        [endpoint]: registryPayload([
          { name: "io.github.acme/hosted", remotes: [{ type: "sse", url: "https://mcp.acme.com/sse" }] },
        ]),
      }),
    );
    const [entry] = await source.fetchEntries(
      config({ kind: "mcp-registry", url: "https://registry.modelcontextprotocol.io" }),
    );
    expect(entry.mcp).toEqual({ transport: "sse", url: "https://mcp.acme.com/sse", headers: {} });
  });

  it("omits servers this codebase could not actually connect to", async () => {
    const source = new McpRegistryMarketplaceSource(
      stubFetch({
        [endpoint]: registryPayload([
          // streamable-http: the MCP connector speaks stdio and SSE only.
          { name: "io.github.acme/http-only", remotes: [{ type: "streamable-http", url: "https://mcp.acme.com/mcp" }] },
          // oci: running it would mean guessing docker flags.
          { name: "io.github.acme/oci-only", packages: [{ registryType: "oci", identifier: "acme/img" }] },
        ]),
      }),
    );
    expect(
      await source.fetchEntries(config({ kind: "mcp-registry", url: "https://registry.modelcontextprotocol.io" })),
    ).toEqual([]);
  });

  it("follows the cursor across pages", async () => {
    const calls: string[] = [];
    const page2 = "https://registry.modelcontextprotocol.io/v0/servers?limit=100&cursor=next";
    const source = new McpRegistryMarketplaceSource(
      stubFetch(
        {
          [endpoint]: registryPayload(
            [{ name: "a/one", packages: [{ registryType: "npm", identifier: "one", transport: { type: "stdio" } }] }],
            "next",
          ),
          [page2]: registryPayload([
            { name: "a/two", packages: [{ registryType: "npm", identifier: "two", transport: { type: "stdio" } }] },
          ]),
        },
        calls,
      ),
    );

    const entries = await source.fetchEntries(
      config({ kind: "mcp-registry", url: "https://registry.modelcontextprotocol.io" }),
    );
    expect(entries.map((e) => e.name)).toEqual(["one", "two"]);
    expect(calls).toEqual([endpoint, page2]);
  });

  it("uses a URL that already names the endpoint as given", async () => {
    const calls: string[] = [];
    const source = new McpRegistryMarketplaceSource(stubFetch({ [endpoint]: registryPayload([]) }, calls));
    await source.fetchEntries(
      config({ kind: "mcp-registry", url: "https://registry.modelcontextprotocol.io/v0/servers" }),
    );
    expect(calls).toEqual([endpoint]);
  });

  it("reports a payload that is not a registry", async () => {
    const source = new McpRegistryMarketplaceSource(stubFetch({ [endpoint]: { data: [] } }));
    await expect(
      source.fetchEntries(config({ kind: "mcp-registry", url: "https://registry.modelcontextprotocol.io" })),
    ).rejects.toThrow(/does not look like an MCP registry/);
  });
});

describe("ClaudePluginMarketplaceSource", () => {
  const mainUrl = "https://raw.githubusercontent.com/acme/plugins/main/.claude-plugin/marketplace.json";
  const masterUrl = "https://raw.githubusercontent.com/acme/plugins/master/.claude-plugin/marketplace.json";

  it("derives the manifest URL from a repository link", () => {
    expect(manifestCandidates("https://github.com/acme/plugins")).toEqual([mainUrl, masterUrl]);
    expect(manifestCandidates("https://example.com/m.json")).toEqual(["https://example.com/m.json"]);
  });

  it("reads a plugin as a skill entry", async () => {
    const source = new ClaudePluginMarketplaceSource(
      stubFetch({
        [mainUrl]: {
          name: "acme-plugins",
          plugins: [{ name: "pr-review", source: "./plugins/pr-review", description: "Reviews", version: "0.3.0" }],
        },
      }),
    );

    const entries = await source.fetchEntries(
      config({ kind: "claude-plugin", url: "https://github.com/acme/plugins" }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: "skill", name: "pr-review", version: "0.3.0" });
    // A path-shaped source means "inside this marketplace repo".
    expect(entries[0].skill).toEqual({ repo: "acme/plugins" });
  });

  it("falls back to master when main has no manifest", async () => {
    const calls: string[] = [];
    const source = new ClaudePluginMarketplaceSource(
      stubFetch({ [masterUrl]: { plugins: [{ name: "old", source: "./p" }] } }, calls),
    );

    const entries = await source.fetchEntries(
      config({ kind: "claude-plugin", url: "https://github.com/acme/plugins" }),
    );
    expect(entries[0].name).toBe("old");
    expect(calls).toEqual([mainUrl, masterUrl]);
  });

  it("offers each bundled MCP server as its own entry", async () => {
    const source = new ClaudePluginMarketplaceSource(
      stubFetch({
        [mainUrl]: {
          plugins: [
            {
              name: "toolkit",
              source: { source: "github", repo: "acme/toolkit" },
              mcpServers: {
                linear: { command: "npx", args: ["-y", "@acme/linear"] },
                docs: { url: "https://docs.acme.com/sse" },
              },
            },
          ],
        },
      }),
    );

    const entries = await source.fetchEntries(
      config({ kind: "claude-plugin", url: "https://github.com/acme/plugins" }),
    );
    expect(entries.map((e) => `${e.type}:${e.name}`)).toEqual(["skill:toolkit", "mcp:linear", "mcp:docs"]);
    expect(entries[0].skill).toEqual({ repo: "acme/toolkit" });
    expect(entries[2].mcp).toMatchObject({ transport: "sse", url: "https://docs.acme.com/sse" });
  });

  it("reports a repository without a manifest", async () => {
    const source = new ClaudePluginMarketplaceSource(stubFetch({}));
    await expect(
      source.fetchEntries(config({ kind: "claude-plugin", url: "https://github.com/acme/plugins" })),
    ).rejects.toThrow(/No \.claude-plugin\/marketplace\.json found/);
  });

  it("reports a manifest with no plugins", async () => {
    const source = new ClaudePluginMarketplaceSource(stubFetch({ [mainUrl]: { name: "empty" } }));
    await expect(
      source.fetchEntries(config({ kind: "claude-plugin", url: "https://github.com/acme/plugins" })),
    ).rejects.toThrow(/carries no "plugins" array/);
  });
});

describe("GitMarketplaceSource", () => {
  const repoUrl = "https://github.com/acme/pr-review";
  const mcpMain = "https://raw.githubusercontent.com/acme/pr-review/main/.mcp.json";
  const pluginMain = "https://raw.githubusercontent.com/acme/pr-review/main/.claude-plugin/plugin.json";

  it("parses the repository forms an admin actually pastes", () => {
    expect(parseGitRepo("acme/pr-review")).toMatchObject({ owner: "acme", repo: "pr-review" });
    expect(parseGitRepo("https://github.com/acme/pr-review.git")).toMatchObject({ repo: "pr-review" });
    expect(parseGitRepo("git@github.com:acme/pr-review.git")).toMatchObject({ owner: "acme", repo: "pr-review" });
    expect(parseGitRepo("https://gitlab.com/acme/pr-review")?.rawBase).toBe("https://gitlab.com/acme/pr-review/-/raw");
    expect(parseGitRepo("https://github.com/acme")).toBeNull();
  });

  it("offers the repository itself as a skill even with no manifests", async () => {
    const source = new GitMarketplaceSource(stubFetch({}));
    const entries = await source.fetchEntries(config({ kind: "git", url: repoUrl }));

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: "skill", name: "pr-review", homepage: repoUrl });
    expect(entries[0].skill).toEqual({ repo: "acme/pr-review" });
  });

  it("prefers the plugin manifest's own name and description", async () => {
    const source = new GitMarketplaceSource(
      stubFetch({ [pluginMain]: { name: "Review Buddy", description: "Reviews PRs", version: "2.1.0" } }),
    );
    const [entry] = await source.fetchEntries(config({ kind: "git", url: repoUrl }));
    expect(entry).toMatchObject({ name: "review-buddy", title: "Review Buddy", version: "2.1.0" });
  });

  it("adds the servers declared in .mcp.json", async () => {
    const source = new GitMarketplaceSource(
      stubFetch({ [mcpMain]: { mcpServers: { linear: { command: "npx", args: ["-y", "@acme/linear"] } } } }),
    );
    const entries = await source.fetchEntries(config({ kind: "git", url: repoUrl }));

    expect(entries.map((e) => `${e.type}:${e.name}`)).toEqual(["skill:pr-review", "mcp:linear"]);
    expect(entries[1].mcp).toMatchObject({ transport: "stdio", command: "npx", args: ["-y", "@acme/linear"] });
  });

  it("rejects a URL that is not a repository", async () => {
    const source = new GitMarketplaceSource(stubFetch({}));
    await expect(source.fetchEntries(config({ kind: "git", url: "not a url" }))).rejects.toThrow(
      /is not a repository URL/,
    );
  });
});
