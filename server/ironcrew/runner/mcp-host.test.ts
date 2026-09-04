/**
 * The runner's MCP host — the half that actually holds the API keys.
 *
 * The connector is faked here (spawning a real MCP server would test npx, not
 * this); what is under test is the lifecycle: replace rather than reuse, a
 * missing server as an error rather than a throw, and nothing left running
 * after a shutdown.
 */

import { describe, it, expect } from "vitest";
import { LocalMcpHost } from "./mcp-host.ts";
import type { McpConnector } from "../../connectors/built-in/mcp/mcp-connector.ts";
import type { McpServerConfig } from "../../connectors/built-in/mcp/mcp-config.ts";

function config(over: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    name: "github",
    transport: "stdio",
    command: "npx",
    enabled: true,
    autoConnect: true,
    timeout_ms: 30_000,
    ...over,
  };
}

/** A connector that records what happened to it, with no process behind it. */
function fakeConnector(over: Partial<Record<"connectThrows", string>> = {}) {
  const state = { connects: 0, disconnects: 0, calls: [] as Array<{ tool: string; input: unknown }> };
  const connector = {
    capabilities: [{ name: "search_issues", description: "", inputSchema: {}, outputSchema: {} }],
    connect: async () => {
      state.connects += 1;
      if (over.connectThrows) throw new Error(over.connectThrows);
    },
    disconnect: async () => {
      state.disconnects += 1;
    },
    execute: async (tool: string, input: Record<string, unknown>) => {
      state.calls.push({ tool, input });
      return { status: "success" as const, artifacts: [] };
    },
  };
  return { state, connector: connector as unknown as McpConnector };
}

describe("LocalMcpHost", () => {
  it("starts a server and reports its tools", async () => {
    const { connector, state } = fakeConnector();
    const host = new LocalMcpHost({ createConnector: () => connector });

    const tools = await host.connect(config());
    expect(tools.map((t) => t.name)).toEqual(["search_issues"]);
    expect(state.connects).toBe(1);
    expect(host.serverNames).toEqual(["github"]);
  });

  it("replaces a running server rather than reusing it — the config may have changed", async () => {
    const first = fakeConnector();
    const second = fakeConnector();
    let next = first.connector;
    const host = new LocalMcpHost({ createConnector: () => next });

    await host.connect(config());
    next = second.connector;
    await host.connect(config({ command: "node" }));

    expect(first.state.disconnects).toBe(1);
    expect(second.state.connects).toBe(1);
    expect(host.serverNames).toEqual(["github"]);
  });

  it("forwards a tool call to the right server", async () => {
    const { connector, state } = fakeConnector();
    const host = new LocalMcpHost({ createConnector: () => connector });
    await host.connect(config());

    const result = await host.call("github", "search_issues", { q: "open" });
    expect(result.status).toBe("success");
    expect(state.calls).toEqual([{ tool: "search_issues", input: { q: "open" } }]);
  });

  it("answers a call for an unknown server with an error, so the caller can reconnect", async () => {
    const host = new LocalMcpHost({ createConnector: () => fakeConnector().connector });
    const result = await host.call("ghost", "anything", {});
    expect(result.status).toBe("error");
    expect(result.error).toContain("ghost");
  });

  it("keeps no connector when the start failed", async () => {
    const { connector } = fakeConnector({ connectThrows: "kein npx" });
    const host = new LocalMcpHost({ createConnector: () => connector });

    await expect(host.connect(config())).rejects.toThrow("kein npx");
    expect(host.serverNames).toEqual([]);
  });

  it("disconnect is idempotent — a name that is not running is not an error", async () => {
    const host = new LocalMcpHost({ createConnector: () => fakeConnector().connector });
    await expect(host.disconnect("ghost")).resolves.toBeUndefined();
  });

  it("closes everything at shutdown", async () => {
    const one = fakeConnector();
    const two = fakeConnector();
    let next = one.connector;
    const host = new LocalMcpHost({ createConnector: () => next });
    await host.connect(config({ name: "github" }));
    next = two.connector;
    await host.connect(config({ name: "notion" }));

    await host.closeAll();
    expect(one.state.disconnects).toBe(1);
    expect(two.state.disconnects).toBe(1);
    expect(host.serverNames).toEqual([]);
  });

  it("hands the resolver to the connectors it builds, so refs resolve on this side", async () => {
    // No createConnector override: this exercises the real wiring, which is
    // what decides whether the runner can resolve at all. The vault is made
    // to fail on purpose — the resolution attempt happens before anything is
    // spawned, so the message proves the resolver was reached.
    const host = new LocalMcpHost({
      resolveSecret: async () => {
        throw new Error("Tresor gesperrt");
      },
    });

    let message = "";
    try {
      await host.connect(config({ env: { T: { $secret: { provider: "vaultwarden", itemRef: "GitHub" } } } }));
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toContain("Tresor gesperrt");
    // Not the control plane's refusal: this side has vault access.
    expect(message).not.toContain("IRONCREW_RUNNER_SOCKET");
  });
});
