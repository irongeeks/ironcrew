import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Architectural rule (issue #56, finding C-002):
 *
 * The `server/packs/` layer is the declarative pack-definition layer. It must
 * be self-contained — it MUST NOT import anything from `server/modules/`. The
 * dependency direction is one-way: orchestration (`server/modules/workflow/`)
 * depends on `server/packs/`, never the reverse.
 *
 * This test walks every `.ts`/`.tsx` file under `server/packs/` and inspects
 * its `import` / `export ... from` statements. Any reference to a path that
 * resolves into `server/modules/` is a layering violation.
 */

const REPO_ROOT = path.resolve(__dirname, "../../..");
const PACKS_DIR = path.join(REPO_ROOT, "server", "packs");
const MODULES_DIR = path.join(REPO_ROOT, "server", "modules");

function listSourceFiles(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        stack.push(full);
      } else if (entry.isFile()) {
        if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
          out.push(full);
        }
      }
    }
  }
  return out;
}

const IMPORT_REGEX = /(?:^|\n)\s*(?:import|export)[^'"`;]*?from\s+["']([^"']+)["']/g;
const SIDE_EFFECT_IMPORT_REGEX = /(?:^|\n)\s*import\s+["']([^"']+)["']/g;

function collectImports(source: string): string[] {
  const refs: string[] = [];
  for (const match of source.matchAll(IMPORT_REGEX)) {
    refs.push(match[1]);
  }
  for (const match of source.matchAll(SIDE_EFFECT_IMPORT_REGEX)) {
    refs.push(match[1]);
  }
  return refs;
}

describe("architecture: server/packs layering", () => {
  it("does not import anything from server/modules/", () => {
    const files = listSourceFiles(PACKS_DIR);
    expect(files.length).toBeGreaterThan(0);

    const violations: { file: string; spec: string }[] = [];

    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      const specs = collectImports(source);

      for (const spec of specs) {
        // Only relative specifiers can reach into a sibling directory.
        if (!spec.startsWith(".")) continue;

        const resolved = path.resolve(path.dirname(file), spec);
        const normalized = resolved.endsWith(path.sep) ? resolved.slice(0, -1) : resolved;

        if (normalized === MODULES_DIR || normalized.startsWith(MODULES_DIR + path.sep)) {
          violations.push({ file: path.relative(REPO_ROOT, file), spec });
        }
      }
    }

    if (violations.length > 0) {
      const detail = violations.map((v) => `  ${v.file} -> ${v.spec}`).join("\n");
      throw new Error(
        `server/packs/ must not import from server/modules/. Found ${violations.length} violation(s):\n${detail}`,
      );
    }

    expect(violations).toEqual([]);
  });
});
