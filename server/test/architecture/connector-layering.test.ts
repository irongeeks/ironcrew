import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Architectural rule: server/connectors/ is the lower platform layer.
 * It must NOT import from server/modules/ (workflow or anything else).
 * server/modules/ depends on server/connectors/, never the other way around.
 *
 * This test walks every .ts file under server/connectors/ and asserts that
 * no static or dynamic import resolves to a path under server/modules/.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const CONNECTORS_ROOT = path.join(REPO_ROOT, "server", "connectors");

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      out.push(...walkTsFiles(full));
    } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      out.push(full);
    }
  }
  return out;
}

// Match `import ... from "..."`, `export ... from "..."`, and dynamic `import("...")`.
const IMPORT_REGEX =
  /(?:^|\s)(?:import|export)\s+(?:[^"';]*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

function extractImportSpecifiers(source: string): string[] {
  const specs: string[] = [];
  let match: RegExpExecArray | null;
  IMPORT_REGEX.lastIndex = 0;
  while ((match = IMPORT_REGEX.exec(source)) !== null) {
    const spec = match[1] ?? match[2];
    if (spec) specs.push(spec);
  }
  return specs;
}

function resolveSpecifier(fromFile: string, spec: string): string | null {
  // Only relative specifiers can resolve back into our source tree.
  if (!spec.startsWith(".")) return null;
  return path.resolve(path.dirname(fromFile), spec);
}

describe("architecture: connector layering", () => {
  it("no file under server/connectors/ imports from server/modules/", () => {
    const files = walkTsFiles(CONNECTORS_ROOT);
    expect(files.length).toBeGreaterThan(0);

    const violations: Array<{ file: string; specifier: string; resolved: string }> = [];
    const modulesRoot = path.join(REPO_ROOT, "server", "modules") + path.sep;

    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      const specs = extractImportSpecifiers(source);
      for (const spec of specs) {
        const resolved = resolveSpecifier(file, spec);
        if (!resolved) continue;
        if (resolved.startsWith(modulesRoot)) {
          violations.push({
            file: path.relative(REPO_ROOT, file),
            specifier: spec,
            resolved: path.relative(REPO_ROOT, resolved),
          });
        }
      }
    }

    if (violations.length > 0) {
      const details = violations
        .map((v) => `  - ${v.file}\n      imports "${v.specifier}"\n      resolves to: ${v.resolved}`)
        .join("\n");
      throw new Error(
        `Layering violation: server/connectors/ must not import from server/modules/.\n` +
          `Found ${violations.length} cross-layer import(s):\n${details}`,
      );
    }

    expect(violations).toHaveLength(0);
  });
});
