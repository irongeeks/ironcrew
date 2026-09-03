import { describe, it, expect } from "vitest";
import { NodeTypeRegistry } from "../../node-types/node-type-registry.ts";
import type { NodeTypeDefinition } from "../../node-types/node-type-interface.ts";

function makeNode(key: string): NodeTypeDefinition {
  return {
    key,
    meta: {
      label: `Test Node ${key}`,
      description: "A test node",
      icon: "🔧",
      color: "#aaa",
      category: "custom",
    },
    configSchema: [],
    inputs: [],
    outputs: [],
    async execute() {
      return { status: "success", outputs: {}, summary: "ok" };
    },
  };
}

describe("NodeTypeRegistry", () => {
  it("registers and retrieves a node type by key", () => {
    const registry = new NodeTypeRegistry();
    registry.register(makeNode("echo"));
    expect(registry.get("echo")).toBeDefined();
    expect(registry.get("echo")!.key).toBe("echo");
  });

  it("returns undefined for unknown key", () => {
    const registry = new NodeTypeRegistry();
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  it("lists all registered node types", () => {
    const registry = new NodeTypeRegistry();
    registry.register(makeNode("alpha"));
    registry.register(makeNode("beta"));
    const list = registry.list();
    expect(list).toHaveLength(2);
    expect(list.map((n) => n.key)).toEqual(expect.arrayContaining(["alpha", "beta"]));
  });

  it("community node overrides built-in with same key", () => {
    const registry = new NodeTypeRegistry();
    const original = makeNode("my_node");
    const override = { ...makeNode("my_node"), meta: { ...makeNode("my_node").meta, label: "Overridden" } };
    registry.register(original);
    registry.register(override);
    expect(registry.get("my_node")!.meta.label).toBe("Overridden");
  });
});
