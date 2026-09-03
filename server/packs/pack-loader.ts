import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import { PackDefinitionSchema, type PackDefinition } from "./pack-schema.ts";
import { buildGraph, type PackGraph } from "./graph-builder.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LoadedPack {
  key: string;
  source: "built-in" | "community";
  definition: PackDefinition;
  graph: PackGraph;
  /** "phaseId.lang" → markdown content */
  guidanceCache: Map<string, string>;
  /** "lang" → shared guidance content (prepended to all phases) */
  sharedGuidanceCache: Map<string, string>;
}

// ---------------------------------------------------------------------------
// Supported languages for guidance file resolution
// ---------------------------------------------------------------------------

const SUPPORTED_LANGS = ["en", "ko", "ja", "zh", "de"] as const;

// ---------------------------------------------------------------------------
// PackLoader
// ---------------------------------------------------------------------------

export class PackLoader {
  /**
   * Scan both directories for subdirectories containing pack.yaml.
   * Community packs override built-in packs with the same key.
   */
  async loadAll(builtInDir: string, communityDir: string): Promise<LoadedPack[]> {
    const builtInPacks = await this._scanDir(builtInDir, "built-in");
    const communityPacks = await this._scanDir(communityDir, "community");

    // Merge: community overrides built-in by key
    const merged = new Map<string, LoadedPack>();

    for (const pack of builtInPacks) {
      merged.set(pack.key, pack);
    }

    for (const pack of communityPacks) {
      merged.set(pack.key, pack);
    }

    return Array.from(merged.values());
  }

  /**
   * Load a single pack from a directory containing pack.yaml.
   */
  async loadPack(dir: string, source: "built-in" | "community"): Promise<LoadedPack> {
    const yamlPath = path.join(dir, "pack.yaml");
    const rawContent = await fs.readFile(yamlPath, "utf8");

    // Parse YAML with safe schema (JSON-safe types only)
    // maxAliases limits alias expansion to prevent billion-laughs DoS attacks.
    // The option is supported by js-yaml 4.x but missing from @types/js-yaml.
    const parsed = yaml.load(rawContent, {
      schema: yaml.JSON_SCHEMA,
      maxAliases: 32,
    } as yaml.LoadOptions & { maxAliases: number });

    // Validate with Zod
    const definition = PackDefinitionSchema.parse(parsed);

    // Build graph (runs all validations: refs, acyclicity, orphans, topo sort)
    const graph = buildGraph(definition.pack.key, definition.phases);

    // Load guidance files for each phase
    const guidanceCache = new Map<string, string>();
    for (const phase of definition.phases) {
      const guidanceTemplate = phase.guidance;

      for (const lang of SUPPORTED_LANGS) {
        const relativePath = guidanceTemplate.replace("{lang}", lang);
        const fullPath = path.join(dir, relativePath);

        // Guidance files are optional — only warn for missing primary language (en).
        // Non-English translations are expected to be absent for most packs.
        try {
          const content = await fs.readFile(fullPath, "utf8");
          guidanceCache.set(`${phase.id}.${lang}`, content);
        } catch {
          if (lang === "en") {
            console.warn(`[PackLoader] Missing guidance file for phase "${phase.id}" (lang: ${lang}): ${fullPath}`);
          }
        }
      }
    }

    // Load shared guidance (pack-level, prepended to all phases)
    const sharedGuidanceCache = new Map<string, string>();
    if (definition.pack.shared_guidance) {
      for (const lang of SUPPORTED_LANGS) {
        const sharedPath = path.join(dir, definition.pack.shared_guidance.replace("{lang}", lang));
        try {
          const content = await fs.readFile(sharedPath, "utf8");
          sharedGuidanceCache.set(lang, content.trim());
        } catch {
          // Missing language file is fine — English fallback applies
        }
      }
      if (sharedGuidanceCache.size === 0) {
        console.warn(`[PackLoader] shared_guidance defined for "${definition.pack.key}" but no files found`);
      }
    }

    return {
      key: definition.pack.key,
      source,
      definition,
      graph,
      guidanceCache,
      sharedGuidanceCache,
    };
  }

  /**
   * Get guidance for a phase + language, with fallback to "en".
   * Returns empty string if no guidance exists.
   */
  getGuidance(pack: LoadedPack, phaseId: string, lang: string): string {
    const cached = pack.guidanceCache.get(`${phaseId}.${lang}`);
    if (cached !== undefined) {
      return cached;
    }

    // Fallback to English
    const fallback = pack.guidanceCache.get(`${phaseId}.en`);
    if (fallback !== undefined) {
      return fallback;
    }

    return "";
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async _scanDir(dir: string, source: "built-in" | "community"): Promise<LoadedPack[]> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      // Missing community dir is expected; warn on other failures
      if (source === "community") return [];
      console.warn(`[PackLoader] Cannot read ${source} pack directory "${dir}":`, err);
      return [];
    }

    const packs: LoadedPack[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith("_")) {
        continue;
      }

      const packDir = path.join(dir, entry.name);

      // Skip directories that don't contain a pack.yaml (e.g. position-only folders)
      try {
        await fs.access(path.join(packDir, "pack.yaml"));
      } catch {
        continue;
      }

      try {
        const loaded = await this.loadPack(packDir, source);
        packs.push(loaded);
      } catch (err) {
        console.error(`[PackLoader] Failed to load ${source} pack from "${entry.name}":`, err);
      }
    }

    return packs;
  }
}
