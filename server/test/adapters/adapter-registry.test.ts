import { describe, it, expect, beforeEach } from "vitest";
import { AdapterRegistry } from "../../adapters/registry.ts";
import type { CliAdapter } from "../../adapters/adapter-interface.ts";

function createMockCliAdapter(providerType: string): CliAdapter {
  return {
    name: `Mock ${providerType}`,
    providerType,
    transport: "cli" as const,
    supportsTokenTracking: false,
    promptDelivery: "stdin" as const,
    buildArgs: () => [providerType, "--test"],
    parseStreamChunk: () => [],
    testEnvironment: async () => ({ ok: true, message: "mock" }),
  };
}

describe("AdapterRegistry", () => {
  let registry: AdapterRegistry;

  beforeEach(() => {
    registry = new AdapterRegistry();
  });

  it("registers and retrieves an adapter", () => {
    const adapter = createMockCliAdapter("claude");
    registry.register(adapter);
    expect(registry.get("claude")).toBe(adapter);
  });

  it("throws on unknown provider", () => {
    expect(() => registry.get("unknown")).toThrow("No adapter registered for provider: unknown");
  });

  it("lists registered adapters", () => {
    registry.register(createMockCliAdapter("claude"));
    registry.register(createMockCliAdapter("codex"));
    const list = registry.list();
    expect(list).toHaveLength(2);
    expect(list.map((a) => a.providerType)).toEqual(["claude", "codex"]);
  });

  it("listAvailable() returns correct shape with available flag per adapter", async () => {
    const availableAdapter: CliAdapter = {
      ...createMockCliAdapter("claude"),
      testEnvironment: async () => ({ ok: true, message: "found" }),
    };
    const unavailableAdapter: CliAdapter = {
      ...createMockCliAdapter("codex"),
      testEnvironment: async () => ({ ok: false, message: "not found" }),
    };

    registry.register(availableAdapter);
    registry.register(unavailableAdapter);

    const result = await registry.listAvailable();

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      providerType: "claude",
      available: true,
    });
    expect(result[1]).toMatchObject({
      providerType: "codex",
      available: false,
    });
  });
});
