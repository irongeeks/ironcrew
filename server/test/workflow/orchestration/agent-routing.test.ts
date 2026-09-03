import { describe, it, expect } from "vitest";
import { resolveAgentRouting } from "../../../modules/workflow/orchestration/agent-routing.ts";

describe("resolveAgentRouting", () => {
  const mockPackRegistry = {
    get(key: string) {
      if (key === "development") {
        return { definition: { pack: { agent_routing: "department" } } };
      }
      if (key === "custom_single") {
        return { definition: { pack: { agent_routing: "single" } } };
      }
      if (key === "no_routing") {
        return { definition: { pack: {} } };
      }
      throw new Error("pack not found");
    },
  };

  it("returns task-level routing when explicitly set to single", () => {
    expect(
      resolveAgentRouting({ agent_routing: "single", workflow_pack_key: "development" }, mockPackRegistry as any),
    ).toBe("single");
  });

  it("returns task-level routing when explicitly set to department", () => {
    expect(resolveAgentRouting({ agent_routing: "department", workflow_pack_key: null }, mockPackRegistry as any)).toBe(
      "department",
    );
  });

  it("falls back to pack default when task routing is null", () => {
    expect(
      resolveAgentRouting({ agent_routing: null, workflow_pack_key: "development" }, mockPackRegistry as any),
    ).toBe("department");
  });

  it("falls back to pack default single", () => {
    expect(
      resolveAgentRouting({ agent_routing: null, workflow_pack_key: "custom_single" }, mockPackRegistry as any),
    ).toBe("single");
  });

  it("defaults to department when pack has no routing field", () => {
    expect(resolveAgentRouting({ agent_routing: null, workflow_pack_key: "no_routing" }, mockPackRegistry as any)).toBe(
      "department",
    );
  });

  it("defaults to department when pack not found", () => {
    expect(
      resolveAgentRouting({ agent_routing: null, workflow_pack_key: "nonexistent" }, mockPackRegistry as any),
    ).toBe("department");
  });

  it("defaults to department when no pack key and no task routing", () => {
    expect(resolveAgentRouting({ agent_routing: null, workflow_pack_key: null }, null)).toBe("department");
  });
});
