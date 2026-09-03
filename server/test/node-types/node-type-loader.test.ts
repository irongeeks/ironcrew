import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadNodeTypes } from "../../node-types/node-type-loader.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const builtInDir = path.resolve(__dirname, "../../node-types/built-in");
const communityDir = path.resolve(__dirname, "../../node-types/community");

describe("loadNodeTypes", () => {
  it("loads built-in node types", async () => {
    const registry = await loadNodeTypes(builtInDir, communityDir);
    expect(registry.list().length).toBeGreaterThan(0);
  });

  it("loads the echo built-in node type", async () => {
    const registry = await loadNodeTypes(builtInDir, communityDir);
    expect(registry.get("echo")).toBeDefined();
    expect(registry.get("echo")!.meta.label).toBe("Echo");
  });

  it("does not throw when community dir is empty or missing", async () => {
    const registry = await loadNodeTypes(builtInDir, "/nonexistent/community/dir");
    expect(registry.list().length).toBeGreaterThan(0); // built-ins still loaded
  });
});
