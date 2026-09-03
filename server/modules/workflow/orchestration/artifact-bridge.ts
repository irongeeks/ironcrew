import { readFile, readdir, realpath } from "node:fs/promises";
import { join, dirname, basename, extname, resolve as pathResolve, sep } from "node:path";
import { parseInputRef } from "../../../packs/graph-builder.ts";
import type { PhaseOutput } from "../../../packs/pack-schema.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ArtifactBridgeContext {
  taskId: string;
  rootDir: string; // project root where artifact files live
  packDir: string; // pack directory (for schema file resolution)
}

// ---------------------------------------------------------------------------
// resolveArtifactRef
// ---------------------------------------------------------------------------

/**
 * Resolve a single artifact reference string to its file content.
 *
 * Supported ref forms:
 *   "concept.concept_doc"                  — direct read
 *   "image_generation.image.*"             — wildcard: read all files matching the {n} pattern
 *   "image_generation.image[{n}]"          — indexed: read file at fanOutIndex
 *   "screenplay.shot_list.scenes[{n}]"     — JSON path with optional index
 *   "input.depth"                          — pack input (returns null, no warning)
 */
export async function resolveArtifactRef(
  rootDir: string,
  ref: string,
  outputDefs: Map<string, PhaseOutput>,
  fanOutIndex?: number,
): Promise<{ content: string | null; warning?: string }> {
  const parsed = parseInputRef(ref);

  // Pack inputs are not resolved from files
  if (parsed.isPackInput) {
    return { content: null };
  }

  // Strip bracket notation from outputName when looking up the output definition.
  // e.g. parseInputRef("image_generation.image[{n}]") → outputName = "image[{n}]"
  // but the output def is keyed as "image_generation.image"
  const cleanOutputName = parsed.outputName.replace(/\[\{n\}\]$/, "").replace(/\[\d+\]$/, "");
  const defKey = `${parsed.sourcePhaseId}.${cleanOutputName}`;
  const outputDef = outputDefs.get(defKey);

  if (!outputDef) {
    return { content: null, warning: `Output definition not found for ref "${ref}" (key: "${defKey}")` };
  }

  // Resolve output path relative to rootDir. Pack YAML defines relative paths
  // like "video_output/concept.md" which must be anchored to the project root.
  const absOutputPath = outputDef.path.startsWith("/") ? outputDef.path : join(rootDir, outputDef.path);

  // Verify resolved path stays within project root (prevents traversal via symlinks
  // or crafted relative paths for all ref types: direct, wildcard, indexed, jsonPath).
  const resolvedAbsOutput = pathResolve(absOutputPath);
  const resolvedRoot = pathResolve(rootDir);
  if (resolvedAbsOutput !== resolvedRoot && !resolvedAbsOutput.startsWith(resolvedRoot + sep)) {
    return { content: null, warning: `Artifact path escapes project root for ref "${ref}": ${absOutputPath}` };
  }

  // ------------------------------------------------------------------
  // Wildcard ref: e.g. "image_generation.image.*"
  // ------------------------------------------------------------------
  if (parsed.isWildcard) {
    return resolveWildcardRef({ ...outputDef, path: absOutputPath }, rootDir);
  }

  // ------------------------------------------------------------------
  // Indexed ref: e.g. "image_generation.image[{n}]" or with jsonPath
  // ------------------------------------------------------------------
  if (parsed.indexPlaceholder) {
    const index = fanOutIndex ?? 0;
    // Replace {n} in the path with the concrete index
    const resolvedPath = absOutputPath.replace("{n}", String(index));

    // Verify path stays within rootDir after placeholder replacement to prevent traversal
    const resolvedAbsolute = pathResolve(resolvedPath);
    const rootAbsolute = pathResolve(rootDir);
    if (resolvedAbsolute !== rootAbsolute && !resolvedAbsolute.startsWith(rootAbsolute + sep)) {
      return { content: null, warning: `Artifact path escapes project root after placeholder replacement: ${ref}` };
    }

    // If there's a jsonPath alongside the index placeholder, this is a JSON
    // array extraction (e.g. "screenplay.shot_list.scenes[{n}]")
    if (parsed.jsonPath) {
      return resolveJsonPathRef(resolvedPath, parsed.jsonPath, ref, index, rootDir);
    }

    return readFileContent(resolvedPath, ref, rootDir);
  }

  // ------------------------------------------------------------------
  // JSON sub-path ref: e.g. "planning.report_meta.title"
  // ------------------------------------------------------------------
  if (parsed.jsonPath) {
    return resolveJsonPathRef(absOutputPath, parsed.jsonPath, ref, undefined, rootDir);
  }

  // ------------------------------------------------------------------
  // Direct ref: plain file read
  // ------------------------------------------------------------------
  const result = await readFileContent(absOutputPath, ref, rootDir);

  // Non-blocking schema validation if defined on the output
  if (result.content !== null && outputDef.schema) {
    // We don't have a packDir here so we skip validation (packDir is only
    // available in bridgeArtifactsForPhase). Validation is still exposed
    // via the standalone validateArtifact function.
  }

  return result;
}

// ---------------------------------------------------------------------------
// validateArtifact
// ---------------------------------------------------------------------------

/**
 * Validate artifact content against a JSON Schema file.
 * Non-blocking: always returns a result object rather than throwing.
 *
 * Supports a subset of JSON Schema draft-07 sufficient for the project:
 *   type, required, properties (with nested type), items, minLength, minimum
 */
export async function validateArtifact(
  content: string,
  schemaPath: string, // relative path within packDir
  packDir: string,
): Promise<{ valid: boolean; error?: string }> {
  // Load schema file
  let schema: unknown;
  try {
    const schemaFullPath = join(packDir, schemaPath);
    const raw = await readFile(schemaFullPath, "utf8");
    schema = JSON.parse(raw);
  } catch (err) {
    return { valid: false, error: `Failed to load schema "${schemaPath}": ${String(err)}` };
  }

  // Parse content as JSON
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch (err) {
    return { valid: false, error: `Content is not valid JSON: ${String(err)}` };
  }

  // Validate against schema
  const error = validateValue(data, schema as JsonSchema, "$");
  if (error) {
    return { valid: false, error };
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// bridgeArtifactsForPhase
// ---------------------------------------------------------------------------

/**
 * Resolve all inputs for a target phase and append them to the subtask description.
 * The subtask is identified by taskId + targetPhaseId via the subtasks table.
 */
export async function bridgeArtifactsForPhase(
  db: { run: (sql: string, ...args: unknown[]) => unknown; get: (sql: string, ...args: unknown[]) => unknown },
  ctx: ArtifactBridgeContext,
  targetPhaseId: string,
  phaseInputs: Array<{ name: string; from: string }>,
  outputDefs: Map<string, PhaseOutput>,
  fanOutIndex?: number,
): Promise<{ bridged: boolean; warnings: string[] }> {
  const warnings: string[] = [];
  const artifactParts: string[] = [];

  for (const input of phaseInputs) {
    const { content, warning } = await resolveArtifactRef(ctx.rootDir, input.from, outputDefs, fanOutIndex);

    if (warning) {
      warnings.push(warning);
    }

    if (content !== null) {
      artifactParts.push(`--- Artifact: ${input.name} ---\n${content}\n`);
    }
  }

  if (artifactParts.length === 0) {
    // Nothing to inject — could be all pack inputs or all missing
    return { bridged: warnings.length === 0, warnings };
  }

  const artifactSummary = "\n\n" + artifactParts.join("\n");

  // Update the subtask description by appending the artifact summary.
  // Subtask is matched by task_id and a title containing the phase id,
  // mirroring the naming convention used throughout the codebase.
  const subtaskRow = db.get(
    "SELECT id, description FROM subtasks WHERE task_id = ? AND title LIKE ? LIMIT 1",
    ctx.taskId,
    `%${targetPhaseId}%`,
  ) as { id: string; description: string | null } | undefined;

  if (subtaskRow) {
    const currentDesc = subtaskRow.description ?? "";
    db.run(
      "UPDATE subtasks SET description = ? WHERE id = ? AND task_id = ?",
      currentDesc + artifactSummary,
      subtaskRow.id,
      ctx.taskId,
    );
  }

  return { bridged: true, warnings };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Verify that the real (symlink-resolved) path stays within the allowed root.
 * Returns the real path on success, or an error string on violation.
 */
async function verifyRealPath(
  filePath: string,
  allowedRoot: string,
): Promise<{ realPath: string } | { notFound: true } | { error: string }> {
  try {
    const real = await realpath(filePath);
    const realRoot = await realpath(allowedRoot);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) {
      return { error: `symlink escapes project root: ${filePath} → ${real}` };
    }
    return { realPath: real };
  } catch (err) {
    // File doesn't exist — not a symlink concern; let callers handle normally
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      return { notFound: true };
    }
    return { error: `failed to resolve path: ${filePath}` };
  }
}

async function readFileContent(
  filePath: string,
  ref: string,
  rootDir?: string,
): Promise<{ content: string | null; warning?: string }> {
  try {
    // When rootDir is provided, verify symlinks resolve within bounds before reading
    if (rootDir) {
      const check = await verifyRealPath(filePath, rootDir);
      if ("error" in check) {
        return { content: null, warning: `Artifact blocked for ref "${ref}": ${check.error}` };
      }
      // notFound falls through to readFile which produces the normal "not found" warning
    }
    const content = await readFile(filePath, "utf8");
    return { content };
  } catch {
    return { content: null, warning: `Artifact file not found for ref "${ref}": ${filePath}` };
  }
}

async function resolveWildcardRef(
  outputDef: PhaseOutput,
  rootDir?: string,
): Promise<{ content: string | null; warning?: string }> {
  // Derive the directory and filename pattern from the output path.
  // e.g. "/tmp/images/image_{n}.png" → dir="/tmp/images", pattern with {n} replaced by *
  const dir = dirname(outputDef.path);
  const filePattern = basename(outputDef.path).replace("{n}", "*");
  const ext = extname(outputDef.path);

  // Verify the directory itself doesn't escape via symlink
  if (rootDir) {
    const dirCheck = await verifyRealPath(dir, rootDir);
    if ("error" in dirCheck) {
      return { content: null, warning: `Wildcard directory blocked: ${dirCheck.error}` };
    }
    // notFound falls through to readdir which produces the normal "not accessible" warning
  }

  let entries: string[];
  try {
    const all = await readdir(dir);
    // Filter to files matching the pattern (simple prefix/suffix match)
    const prefix = filePattern.substring(0, filePattern.indexOf("*"));
    const suffix = filePattern.substring(filePattern.indexOf("*") + 1);
    entries = all
      .filter((f) => f.startsWith(prefix) && f.endsWith(suffix) && (ext === "" || f.endsWith(ext)))
      .sort()
      .map((f) => join(dir, f));
  } catch {
    return { content: null, warning: `Wildcard directory not accessible: ${dir}` };
  }

  if (entries.length === 0) {
    return { content: null, warning: `No files matched wildcard pattern in "${dir}" (pattern: "${filePattern}")` };
  }

  const parts = await Promise.all(
    entries.map(async (p) => {
      try {
        // Verify each matched file stays within bounds (individual files could be symlinks)
        if (rootDir) {
          const check = await verifyRealPath(p, rootDir);
          if ("error" in check) return null;
        }
        return await readFile(p, "utf8");
      } catch {
        return null;
      }
    }),
  );

  const joined = parts.filter((c): c is string => c !== null).join("\n");
  return { content: joined };
}

async function resolveJsonPathRef(
  filePath: string,
  jsonPath: string,
  ref: string,
  arrayIndex: number | undefined,
  rootDir?: string,
): Promise<{ content: string | null; warning?: string }> {
  // Verify symlinks resolve within project root before reading
  if (rootDir) {
    const check = await verifyRealPath(filePath, rootDir);
    if ("error" in check) {
      return { content: null, warning: `Artifact blocked for ref "${ref}": ${check.error}` };
    }
    // notFound falls through to readFile which produces the normal "not found" warning
  }
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return { content: null, warning: `Artifact file not found for ref "${ref}": ${filePath}` };
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return { content: null, warning: `Failed to parse JSON for ref "${ref}": ${String(err)}` };
  }

  // Navigate the jsonPath (e.g. ".scenes[{n}]" or ".title")
  // We normalise the path and walk it step by step.
  // Strip leading dot: ".scenes" → "scenes"
  const normalised = jsonPath.startsWith(".") ? jsonPath.slice(1) : jsonPath;

  // Split on dots but keep bracket access as part of a segment
  // e.g. "scenes[{n}]" → segment "scenes[{n}]"
  // e.g. "scenes.length" → ["scenes", "length"]
  const segments = splitJsonPath(normalised);

  let current: unknown = data;
  for (const segment of segments) {
    if (current === null || current === undefined) {
      return {
        content: null,
        warning: `JSON path "${jsonPath}" traversal hit null/undefined at segment "${segment}" for ref "${ref}"`,
      };
    }

    // Bracket index access: e.g. "scenes[{n}]" or "scenes[0]"
    const bracketMatch = /^(.+)\[(\{n\}|\d+)\]$/.exec(segment);
    if (bracketMatch) {
      const key = bracketMatch[1];
      const indexStr = bracketMatch[2];
      const idx = indexStr === "{n}" ? (arrayIndex ?? 0) : parseInt(indexStr, 10);

      // Navigate to the key first
      if (!isObject(current)) {
        return {
          content: null,
          warning: `Expected object at segment "${key}" but got ${typeof current} for ref "${ref}"`,
        };
      }
      const arr = (current as Record<string, unknown>)[key];
      if (!Array.isArray(arr)) {
        return { content: null, warning: `Expected array at key "${key}" for ref "${ref}"` };
      }
      current = arr[idx];
      continue;
    }

    // Plain property access
    if (!isObject(current)) {
      return {
        content: null,
        warning: `Expected object at segment "${segment}" but got ${typeof current} for ref "${ref}"`,
      };
    }
    current = (current as Record<string, unknown>)[segment];
  }

  if (current === undefined) {
    return { content: null, warning: `JSON path "${jsonPath}" resolved to undefined for ref "${ref}"` };
  }

  // Return scalar as string, objects/arrays as JSON
  const content = typeof current === "object" ? JSON.stringify(current) : String(current);
  return { content };
}

function splitJsonPath(path: string): string[] {
  // Split on "." but not inside brackets — for our supported syntax this is
  // straightforward since bracket notation doesn't contain dots inside.
  return path.split(".").filter(Boolean);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Minimal JSON Schema validator (subset: type, required, properties, items)
// ---------------------------------------------------------------------------

interface JsonSchema {
  type?: string | string[];
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  minimum?: number;
  minLength?: number;
}

function validateValue(value: unknown, schema: JsonSchema, path: string): string | undefined {
  // type check
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actualType = getJsonType(value);
    if (!types.includes(actualType)) {
      return `${path}: expected type "${types.join("|")}" but got "${actualType}"`;
    }
  }

  // required properties
  if (schema.required && Array.isArray(schema.required)) {
    if (!isObject(value)) {
      return `${path}: expected object for required check`;
    }
    for (const key of schema.required) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        return `${path}: missing required property "${key}"`;
      }
    }
  }

  // properties
  if (schema.properties && isObject(value)) {
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        const err = validateValue((value as Record<string, unknown>)[key], propSchema, `${path}.${key}`);
        if (err) return err;
      }
    }
  }

  // items (array)
  if (schema.items && Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const err = validateValue(value[i], schema.items, `${path}[${i}]`);
      if (err) return err;
    }
  }

  // minimum
  if (schema.minimum !== undefined && typeof value === "number") {
    if (value < schema.minimum) {
      return `${path}: value ${value} is less than minimum ${schema.minimum}`;
    }
  }

  // minLength
  if (schema.minLength !== undefined && typeof value === "string") {
    if (value.length < schema.minLength) {
      return `${path}: string length ${value.length} is less than minLength ${schema.minLength}`;
    }
  }

  return undefined;
}

function getJsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
