import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConnectorRegistry } from "../../connectors/registry.ts";
import type { Connector, ConnectorExecuteResult } from "../../connectors/connector-interface.ts";

function makeConnector(name: string, capabilities: string[] = ["text2img"]): Connector {
  return {
    name,
    capabilities: capabilities.map((c) => ({
      name: c,
      description: `${c} capability`,
      inputSchema: {},
      outputSchema: {},
    })),
    execute: vi.fn().mockResolvedValue({
      status: "success",
      artifacts: [{ path: "/output/result.png", type: "image" }],
      costInfo: { durationMs: 100 },
    } satisfies ConnectorExecuteResult),
    getAgentGuidance: vi.fn().mockReturnValue("Use this connector to generate images."),
    testConnection: vi.fn().mockResolvedValue({ ok: true, message: "Connected" }),
  };
}

describe("ConnectorRegistry", () => {
  let registry: ConnectorRegistry;

  beforeEach(() => {
    registry = new ConnectorRegistry();
  });

  describe("registerConnector + executeCapability", () => {
    it("executes a capability and returns the connector result", async () => {
      const connector = makeConnector("comfyui");
      registry.registerConnector(connector);
      registry.setBinding("text2img", { connector: "comfyui", connector_config: { url: "http://localhost:8188" } });

      const result = await registry.executeCapability("text2img", { prompt: "a cat" });

      expect(result.status).toBe("success");
      expect(result.artifacts).toHaveLength(1);
      expect(connector.execute).toHaveBeenCalledWith("text2img", { prompt: "a cat" }, { url: "http://localhost:8188" });
    });
  });

  describe("executeCapability with no binding", () => {
    it("throws when no binding exists for the capability", async () => {
      const connector = makeConnector("comfyui");
      registry.registerConnector(connector);

      await expect(registry.executeCapability("img2video", {})).rejects.toThrow(/no binding/i);
    });
  });

  describe("executeCapability with timeout", () => {
    it("returns a timeout result when the connector exceeds timeout_ms", async () => {
      vi.useFakeTimers();

      const slowConnector: Connector = {
        name: "slow",
        capabilities: [{ name: "slow_op", description: "slow", inputSchema: {}, outputSchema: {} }],
        execute: () =>
          new Promise<ConnectorExecuteResult>((resolve) =>
            setTimeout(() => resolve({ status: "success", artifacts: [] }), 10_000),
          ),
        testConnection: vi.fn().mockResolvedValue({ ok: true, message: "ok" }),
      };

      registry.registerConnector(slowConnector);
      registry.setBinding("slow_op", { connector: "slow", timeout_ms: 500, connector_config: {} });

      const resultPromise = registry.executeCapability("slow_op", {});
      vi.advanceTimersByTime(600);

      const result = await resultPromise;
      expect(result.status).toBe("timeout");

      vi.useRealTimers();
    });
  });

  describe("getAgentGuidance", () => {
    it("returns guidance string from the bound connector", () => {
      const connector = makeConnector("comfyui");
      registry.registerConnector(connector);
      registry.setBinding("text2img", { connector: "comfyui", connector_config: {} });

      const guidance = registry.getAgentGuidance("text2img", "en");

      expect(guidance).toBe("Use this connector to generate images.");
      expect(connector.getAgentGuidance).toHaveBeenCalledWith("text2img", {}, "en");
    });

    it("returns null when no binding exists", () => {
      expect(registry.getAgentGuidance("unknown_cap", "en")).toBeNull();
    });

    it("returns null when connector has no getAgentGuidance method", () => {
      const connector = makeConnector("comfyui");
      delete (connector as Partial<Connector>).getAgentGuidance;
      registry.registerConnector(connector);
      registry.setBinding("text2img", { connector: "comfyui", connector_config: {} });

      expect(registry.getAgentGuidance("text2img", "en")).toBeNull();
    });
  });

  describe("getAvailableConnectors", () => {
    it("returns connectors that have the requested capability", () => {
      const connectorA = makeConnector("connectorA", ["text2img", "img2video"]);
      const connectorB = makeConnector("connectorB", ["text2img"]);
      const connectorC = makeConnector("connectorC", ["tts"]);
      registry.registerConnector(connectorA);
      registry.registerConnector(connectorB);
      registry.registerConnector(connectorC);

      const result = registry.getAvailableConnectors("text2img");
      const names = result.map((c) => c.name);

      expect(names).toContain("connectorA");
      expect(names).toContain("connectorB");
      expect(names).not.toContain("connectorC");
    });

    it("returns empty array when no connector supports the capability", () => {
      registry.registerConnector(makeConnector("comfyui", ["text2img"]));
      expect(registry.getAvailableConnectors("unknown_cap")).toHaveLength(0);
    });
  });

  describe("retry on error", () => {
    it("does not retry on permanent error status", async () => {
      let callCount = 0;
      const failingConnector: Connector = {
        name: "flaky",
        capabilities: [{ name: "flaky_op", description: "flaky", inputSchema: {}, outputSchema: {} }],
        execute: vi.fn().mockImplementation(async () => {
          callCount++;
          return { status: "error", artifacts: [], error: "permanent failure" } satisfies ConnectorExecuteResult;
        }),
        testConnection: vi.fn().mockResolvedValue({ ok: true, message: "ok" }),
      };

      registry.registerConnector(failingConnector);
      registry.setBinding("flaky_op", { connector: "flaky", max_retries: 2, connector_config: {} });

      const result = await registry.executeCapability("flaky_op", {});

      // Permanent errors break immediately — only 1 attempt, no retries
      expect(callCount).toBe(1);
      expect(result.status).toBe("error");
    });

    it("retries on timeout and stops on success", async () => {
      let callCount = 0;
      const eventuallySuccessConnector: Connector = {
        name: "eventual",
        capabilities: [{ name: "retry_op", description: "retry", inputSchema: {}, outputSchema: {} }],
        execute: vi.fn().mockImplementation(async () => {
          callCount++;
          if (callCount < 2) {
            return { status: "timeout", artifacts: [], error: "timed out" } satisfies ConnectorExecuteResult;
          }
          return { status: "success", artifacts: [] } satisfies ConnectorExecuteResult;
        }),
        testConnection: vi.fn().mockResolvedValue({ ok: true, message: "ok" }),
      };

      registry.registerConnector(eventuallySuccessConnector);
      registry.setBinding("retry_op", { connector: "eventual", max_retries: 3, connector_config: {} });

      const result = await registry.executeCapability("retry_op", {});

      expect(callCount).toBe(2);
      expect(result.status).toBe("success");
    });

    it("retries up to max_retries times on timeout before giving up", async () => {
      let callCount = 0;
      const timeoutConnector: Connector = {
        name: "slow",
        capabilities: [{ name: "slow_op", description: "slow", inputSchema: {}, outputSchema: {} }],
        execute: vi.fn().mockImplementation(async () => {
          callCount++;
          return { status: "timeout", artifacts: [], error: "timed out" } satisfies ConnectorExecuteResult;
        }),
        testConnection: vi.fn().mockResolvedValue({ ok: true, message: "ok" }),
      };

      registry.registerConnector(timeoutConnector);
      registry.setBinding("slow_op", { connector: "slow", max_retries: 2, connector_config: {} });

      const result = await registry.executeCapability("slow_op", {});

      // 1 initial attempt + 2 retries = 3 total calls
      expect(callCount).toBe(3);
      expect(result.status).toBe("timeout");
    });
  });

  describe("listAll", () => {
    it("returns empty array when no connectors registered", () => {
      expect(registry.listAll()).toEqual([]);
    });

    it("returns all registered connectors", () => {
      const c1 = makeConnector("comfyui", ["text2img"]);
      const c2 = makeConnector("web-search", ["web_search"]);
      registry.registerConnector(c1);
      registry.registerConnector(c2);

      const all = registry.listAll();
      expect(all).toHaveLength(2);
      expect(all.map((c) => c.name)).toEqual(["comfyui", "web-search"]);
    });

    it("returns a new array (not a reference to internal state)", () => {
      const c1 = makeConnector("comfyui");
      registry.registerConnector(c1);

      const a = registry.listAll();
      const b = registry.listAll();
      expect(a).not.toBe(b);
      expect(a).toEqual(b);
    });
  });

  describe("getConnector", () => {
    it("returns undefined for unknown connector name", () => {
      expect(registry.getConnector("nonexistent")).toBeUndefined();
    });

    it("returns the registered connector by name", () => {
      const c = makeConnector("comfyui");
      registry.registerConnector(c);

      expect(registry.getConnector("comfyui")).toBe(c);
    });

    it("returns the correct connector when multiple are registered", () => {
      const c1 = makeConnector("comfyui", ["text2img"]);
      const c2 = makeConnector("web-search", ["web_search"]);
      registry.registerConnector(c1);
      registry.registerConnector(c2);

      expect(registry.getConnector("comfyui")).toBe(c1);
      expect(registry.getConnector("web-search")).toBe(c2);
    });
  });
});
