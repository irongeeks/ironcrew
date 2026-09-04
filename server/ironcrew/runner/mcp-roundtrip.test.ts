/**
 * An MCP server on the runner, called from the control plane.
 *
 * The property this file exists to prove is the one the whole arrangement is
 * for: the control plane sends a *reference* to a credential and receives
 * tool results, and the credential itself never appears on the wire. The
 * socket fixture records every line, so that is an assertion rather than a
 * claim in a comment.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunnerServer } from "./runner-server.ts";
import { RunnerMcpConnector } from "./runner-mcp-client.ts";
import { LocalMcpHost } from "./mcp-host.ts";
import { socketPair, type SocketPair } from "./__fixtures__/socket-pair.ts";
import type { McpConnector } from "../../connectors/built-in/mcp/mcp-connector.ts";
import type { McpServerConfig } from "../../connectors/built-in/mcp/mcp-config.ts";

const TOKEN = "runner-token-geheim";
const SECRET = "ghp_this_must_never_cross_the_wire";

function config(over: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    name: "github",
    transport: "stdio",
    command: "npx",
    env: { NODE_ENV: "production", GITHUB_TOKEN: { $secret: { provider: "vaultwarden", itemRef: "GitHub MCP" } } },
    enabled: true,
    autoConnect: true,
    timeout_ms: 1000,
    ...over,
  };
}

/**
 * A connector standing in for a real MCP server, which reports back the env
 * it was started with — that is how a test can see what the runner resolved
 * without a process being involved.
 */
function fakeConnector(cfg: McpServerConfig, resolve: (ref: { itemRef: string }) => Promise<string>) {
  let startedEnv: Record<string, string> = {};
  return {
    capabilities: [{ name: "search_issues", description: "Sucht Issues", inputSchema: {}, outputSchema: {} }],
    connect: async () => {
      for (const [key, value] of Object.entries(cfg.env ?? {})) {
        startedEnv[key] = typeof value === "string" ? value : await resolve(value.$secret);
      }
    },
    disconnect: async () => {
      startedEnv = {};
    },
    execute: async (tool: string, _input: Record<string, unknown>) => ({
      status: "success" as const,
      artifacts: [
        { path: `mcp://github/${tool}`, type: "text", metadata: { output: `token=${startedEnv.GITHUB_TOKEN}` } },
      ],
      costInfo: { durationMs: 1 },
    }),
  } as unknown as McpConnector;
}

function wired(over: { mcp?: LocalMcpHost | undefined; hasHost?: boolean } = {}) {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ironcrew-mcp-"));
  const host =
    over.hasHost === false
      ? undefined
      : (over.mcp ??
        new LocalMcpHost({
          createConnector: (cfg) => fakeConnector(cfg, async () => SECRET),
        }));
  const server = new RunnerServer({ runtimes: [], token: TOKEN, workspaceRoot, mcp: host });

  const pairs: SocketPair[] = [];
  const connector = new RunnerMcpConnector({
    config: config(),
    token: TOKEN,
    requestTimeoutMs: 2000,
    connect: async () => {
      const pair = socketPair();
      pairs.push(pair);
      server.handleConnection(pair.server);
      return pair.client;
    },
  });

  return {
    connector,
    host,
    /** Every line either side wrote, across every connection. */
    traffic: () => pairs.flatMap((p) => p.traffic).join(""),
    cleanup: () => fs.rmSync(workspaceRoot, { recursive: true, force: true }),
  };
}

describe("an MCP server started on the runner", () => {
  it("reports its tools to the control plane", async () => {
    const { connector, cleanup } = wired();
    await connector.connect();

    expect(connector.connected).toBe(true);
    expect(connector.capabilities.map((c) => c.name)).toEqual(["search_issues"]);
    expect(connector.name).toBe("mcp:github");
    cleanup();
  });

  it("never lets the resolved credential cross the wire", async () => {
    const { connector, traffic, cleanup } = wired();
    await connector.connect();
    const result = await connector.execute("search_issues", { q: "open" }, {});

    // The runner resolved it — the tool ran with the real token …
    expect(result.artifacts[0]?.metadata?.output).toBe(`token=${SECRET}`);
    // … and yet nothing on the socket carries it, except what the tool itself
    // chose to return, which is the tool's business and not this layer's.
    const lines = traffic();
    expect(lines).toContain("GitHub MCP");
    expect(lines).toContain('"$secret"');
    const sentByControlPlane = lines
      .split("\n")
      .filter((line) => line.includes('"mcp-connect"') || line.includes('"mcp-call"'));
    expect(sentByControlPlane.join("\n")).not.toContain(SECRET);
    cleanup();
  });

  it("runs the tool and returns its result unchanged", async () => {
    const { connector, cleanup } = wired();
    await connector.connect();
    const result = await connector.execute("search_issues", { q: "open" }, {});

    expect(result.status).toBe("success");
    expect(result.artifacts[0]?.path).toBe("mcp://github/search_issues");
    cleanup();
  });

  it("keeps the server running between calls — one connection per call, one server", async () => {
    const { connector, host, cleanup } = wired();
    await connector.connect();
    await connector.execute("search_issues", {}, {});
    await connector.execute("search_issues", {}, {});

    expect(host?.serverNames).toEqual(["github"]);
    cleanup();
  });

  it("stops the server on disconnect", async () => {
    const { connector, host, cleanup } = wired();
    await connector.connect();
    await connector.disconnect();

    expect(host?.serverNames).toEqual([]);
    expect(connector.connected).toBe(false);
    cleanup();
  });

  it("says so plainly when the runner hosts no MCP servers", async () => {
    const { connector, cleanup } = wired({ hasHost: false });
    await expect(connector.connect()).rejects.toThrow(/keine MCP-Server/);
    expect(connector.error).toContain("keine MCP-Server");
    cleanup();
  });

  it("reports a vault failure with the item and the key, and no value", async () => {
    const host = new LocalMcpHost({
      resolveSecret: async () => {
        throw new Error("bw ist gesperrt");
      },
    });
    const { connector, cleanup } = wired({ mcp: host });

    let message = "";
    try {
      await connector.connect();
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toContain("GITHUB_TOKEN");
    expect(message).toContain("GitHub MCP");
    expect(message).toContain("bw ist gesperrt");
    cleanup();
  });

  it("turns a call to a server the runner no longer runs into an error, not a throw", async () => {
    const { connector, host, cleanup } = wired();
    await connector.connect();
    await host?.closeAll(); // as if the runner had restarted

    const result = await connector.execute("search_issues", {}, {});
    expect(result.status).toBe("error");
    expect(result.error).toContain("github");
    cleanup();
  });

  it("refuses a connection with the wrong token", async () => {
    const { cleanup } = wired();
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ironcrew-mcp-"));
    const server = new RunnerServer({ runtimes: [], token: TOKEN, workspaceRoot, mcp: new LocalMcpHost() });
    const connector = new RunnerMcpConnector({
      config: config(),
      token: "falsch",
      requestTimeoutMs: 2000,
      connect: async () => {
        const pair = socketPair();
        server.handleConnection(pair.server);
        return pair.client;
      },
    });

    await expect(connector.connect()).rejects.toThrow(/Nicht authentifiziert/);
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    cleanup();
  });
});
