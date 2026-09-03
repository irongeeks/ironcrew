import fs from "node:fs/promises";
import path from "node:path";
import { NodeTypeRegistry } from "./node-type-registry.ts";
import type { NodeTypeDefinition } from "./node-type-interface.ts";

/**
 * Scan a directory for subdirectories that contain an index.ts (or index.js
 * in production builds). Each subdirectory is treated as one node type.
 * Returns the absolute path to each found index file.
 */
async function scanNodeTypeDir(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const results: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const tsPath = path.join(dir, entry.name, "index.ts");
      const jsPath = path.join(dir, entry.name, "index.js");
      // Prefer .ts (dev), fall back to .js (production build)
      try {
        await fs.access(tsPath);
        results.push(tsPath);
      } catch {
        try {
          await fs.access(jsPath);
          results.push(jsPath);
        } catch {
          // Neither exists — skip this subdirectory
        }
      }
    }
    return results;
  } catch {
    // Directory doesn't exist — return empty list silently
    return [];
  }
}

/**
 * Load all node types from built-in and community directories.
 * Community node types override built-in ones with the same key.
 *
 * @param builtInDir  Absolute path to server/node-types/built-in/
 * @param communityDir Absolute path to server/node-types/community/
 */
export async function loadNodeTypes(builtInDir: string, communityDir: string): Promise<NodeTypeRegistry> {
  const registry = new NodeTypeRegistry();

  // Load built-in node types first
  for (const indexPath of await scanNodeTypeDir(builtInDir)) {
    try {
      const mod = await import(indexPath);
      const def = mod.default as NodeTypeDefinition;
      if (def?.key) {
        registry.register(def);
      }
    } catch (err) {
      console.error(`[node-types] Failed to load built-in node type from ${indexPath}:`, err);
    }
  }

  // Load community node types second — same key overrides built-in
  const communityPaths = await scanNodeTypeDir(communityDir);
  if (communityPaths.length > 0) {
    console.warn(
      `[node-types] Loading ${communityPaths.length} community node type(s) — community code runs with full server privileges. Review before use.`,
    );
  }
  for (const indexPath of communityPaths) {
    try {
      const mod = await import(indexPath);
      const def = mod.default as NodeTypeDefinition;
      if (def?.key) {
        registry.register(def);
      }
    } catch (err) {
      console.error(`[node-types] Failed to load community node type from ${indexPath}:`, err);
    }
  }

  return registry;
}
