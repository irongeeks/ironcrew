/**
 * IronCrew — installing what a marketplace offers.
 *
 * The installer is the boundary between third-party JSON and this machine.
 * Everything upstream of it (the four source adapters) only reads and
 * normalises; this is the first place something is written, so this is where
 * the checks live.
 *
 * Where things actually land — IronCrew adds provenance to the infrastructure
 * that already exists rather than a second copy of it:
 *
 *   MCP servers  →  McpManager + the `settings` row "mcp_servers", exactly
 *                   where a hand-added server lives. A marketplace-installed
 *                   server is byte-identical to one an admin typed in.
 *   Skills       →  <skills dir>/<name>/{skills.md, meta.json}, the layout
 *                   the custom-skills route already uses.
 *
 * Four checks stand between a catalog entry and the disk:
 *
 *  1. **The command allowlist.** An MCP `command` from a catalog is arbitrary
 *     code that IronCrew would spawn on connect. Marketplace installs may
 *     only name a known launcher (npx, uvx, node, …). An admin adding a
 *     server by hand through the MCP settings route is unaffected — that is
 *     their own decision about their own machine; a stranger's catalog is not.
 *  2. **McpServerConfigSchema**, the same validation the hand-add route runs:
 *     it rejects shell metacharacters in the command and blocks cloud
 *     metadata endpoints.
 *  3. **Installing a skill never executes anything.** The skill's Markdown is
 *     fetched and written; the source repository's code is not run, not
 *     cloned, and not installed. A skill is text.
 *  4. **Path containment.** A normalised name is joined to the skills
 *     directory and the result re-checked, so no entry can name its way out
 *     of it.
 */

import fs from "node:fs";
import path from "node:path";
import { McpServerConfigSchema, type McpServerConfig } from "../../connectors/built-in/mcp/mcp-config.ts";
import {
  MarketplaceSourceError,
  defaultMarketplaceFetch,
  fetchText,
  normaliseName,
  type FetchLike,
  type MarketplaceEntry,
} from "./marketplace-source.ts";

/**
 * Launchers a marketplace entry may name. Anything else is refused with the
 * command in the message, so an admin can add it by hand if they mean to.
 */
export const ALLOWED_MCP_COMMANDS = [
  "npx",
  "bunx",
  "pnpm",
  "uvx",
  "uv",
  "node",
  "deno",
  "python",
  "python3",
  "dnx",
  "dotnet",
] as const;

/** Matches the cap the custom-skills route already enforces. */
export const MAX_SKILL_BYTES = 512_000;

export class MarketplaceInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketplaceInstallError";
  }
}

/** Where MCP servers are registered. Injected so tests need no live manager. */
export interface McpInstallTarget {
  add(config: McpServerConfig): void | Promise<void>;
  remove(name: string): void | Promise<void>;
  has(name: string): boolean;
}

export interface InstalledSkill {
  name: string;
  path: string;
  bytes: number;
}

export interface InstallResult {
  entryType: "mcp" | "skill";
  name: string;
  /** Where it landed: the MCP server name, or the skill directory. */
  location: string;
}

/**
 * Everything a marketplace entry may need before it can be installed —
 * chiefly the environment values the entry declared but could not carry
 * (API keys and the like), which the admin supplies here.
 */
export interface InstallOptions {
  /** Overrides for the entry's declared env placeholders. */
  env?: Record<string, string>;
  /** Extra headers for an SSE server (an Authorization value, typically). */
  headers?: Record<string, string>;
  /** Install under a different local name, e.g. to avoid a clash. */
  nameOverride?: string;
}

export class MarketplaceInstaller {
  constructor(
    private readonly deps: {
      mcp: McpInstallTarget;
      /** Absolute path of the custom-skills directory. */
      skillsDir: string;
      fetchImpl?: FetchLike;
    },
  ) {}

  private get fetchImpl(): FetchLike {
    return this.deps.fetchImpl ?? defaultMarketplaceFetch;
  }

  // --- MCP ---------------------------------------------------------------

  /**
   * Builds the server config an entry describes, applying the admin's values
   * and running it through the same schema the hand-add route uses.
   *
   * Exported behaviour, not a private detail: the API surface validates
   * before it writes anything, so a rejected entry never half-installs.
   */
  buildMcpConfig(entry: MarketplaceEntry, options: InstallOptions = {}): McpServerConfig {
    if (entry.type !== "mcp" || !entry.mcp) {
      throw new MarketplaceInstallError(`Entry "${entry.id}" does not describe an MCP server.`);
    }
    const name = normaliseName(options.nameOverride ?? entry.name);
    if (!name) throw new MarketplaceInstallError(`Entry "${entry.id}" has no usable server name.`);

    const spec = entry.mcp;
    if (spec.transport === "stdio") {
      const command = (spec.command ?? "").trim();
      if (!ALLOWED_MCP_COMMANDS.includes(command as (typeof ALLOWED_MCP_COMMANDS)[number])) {
        throw new MarketplaceInstallError(
          `"${command || "(empty)"}" is not an allowed launcher for a marketplace install ` +
            `(allowed: ${ALLOWED_MCP_COMMANDS.join(", ")}). Add this server by hand if you mean to run it.`,
        );
      }
    }

    // Declared placeholders first, admin values second: an entry cannot
    // pin a variable the admin wanted to set.
    const env = { ...(spec.env ?? {}), ...(options.env ?? {}) };
    const headers = { ...(spec.headers ?? {}), ...(options.headers ?? {}) };

    const parsed = McpServerConfigSchema.safeParse({
      name,
      label: entry.title || name,
      transport: spec.transport,
      command: spec.command,
      args: spec.args ?? [],
      env,
      url: spec.url,
      headers,
      enabled: true,
      // Marketplace installs do not auto-connect: an admin decides when a
      // stranger's server first runs, not the install click.
      autoConnect: false,
    });
    if (!parsed.success) {
      const detail = parsed.error.issues.map((i) => i.message).join("; ");
      throw new MarketplaceInstallError(`Entry "${entry.id}" is not a valid MCP server: ${detail}`);
    }
    return parsed.data;
  }

  async installMcp(entry: MarketplaceEntry, options: InstallOptions = {}): Promise<InstallResult> {
    const config = this.buildMcpConfig(entry, options);
    await this.deps.mcp.add(config);
    return { entryType: "mcp", name: config.name, location: config.name };
  }

  async uninstallMcp(name: string): Promise<boolean> {
    if (!this.deps.mcp.has(name)) return false;
    await this.deps.mcp.remove(name);
    return true;
  }

  // --- skills ------------------------------------------------------------

  /**
   * Resolves the directory a skill would occupy, refusing anything that
   * escapes the skills directory.
   */
  private skillDir(rawName: string): { name: string; dir: string } {
    const name = normaliseName(rawName);
    if (!name) throw new MarketplaceInstallError(`"${rawName}" is not a usable skill name.`);
    const root = path.resolve(this.deps.skillsDir);
    const dir = path.resolve(root, name);
    if (dir !== path.join(root, name) || !dir.startsWith(root + path.sep)) {
      throw new MarketplaceInstallError(`Skill name "${rawName}" resolves outside the skills directory.`);
    }
    return { name, dir };
  }

  /**
   * Reads a skill's Markdown. A repo entry is resolved to its skill file —
   * fetched, never cloned and never run.
   */
  private async skillContent(entry: MarketplaceEntry): Promise<string> {
    const spec = entry.skill;
    if (!spec) throw new MarketplaceInstallError(`Entry "${entry.id}" does not describe a skill.`);

    if (spec.content) return spec.content;
    if (spec.contentUrl) return await fetchText(spec.contentUrl, "catalog", this.fetchImpl);

    if (spec.repo) {
      const [owner, repo] = spec.repo.split("/");
      if (!owner || !repo) throw new MarketplaceInstallError(`"${spec.repo}" is not an owner/repo reference.`);
      // The conventional file names, on the conventional default branches.
      const candidates: string[] = [];
      for (const branch of ["main", "master"]) {
        for (const file of ["SKILL.md", "skills.md", "skill.md", "README.md"]) {
          candidates.push(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${file}`);
        }
      }
      for (const url of candidates) {
        try {
          const text = await fetchText(url, "git", this.fetchImpl);
          if (text.trim()) return text;
        } catch {
          // Next candidate.
        }
      }
      throw new MarketplaceInstallError(
        `No skill file found in ${spec.repo} (looked for SKILL.md, skills.md, skill.md, README.md).`,
      );
    }

    throw new MarketplaceInstallError(`Entry "${entry.id}" names no skill content.`);
  }

  async installSkill(entry: MarketplaceEntry, options: InstallOptions = {}): Promise<InstallResult> {
    if (entry.type !== "skill") {
      throw new MarketplaceInstallError(`Entry "${entry.id}" does not describe a skill.`);
    }
    const { name, dir } = this.skillDir(options.nameOverride ?? entry.name);

    let content: string;
    try {
      content = await this.skillContent(entry);
    } catch (err) {
      if (err instanceof MarketplaceSourceError) throw new MarketplaceInstallError(err.message);
      throw err;
    }

    const bytes = Buffer.byteLength(content, "utf-8");
    if (bytes > MAX_SKILL_BYTES) {
      throw new MarketplaceInstallError(`Skill "${name}" is ${bytes} bytes, over the ${MAX_SKILL_BYTES} byte limit.`);
    }

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "skills.md"), content, "utf-8");
    const now = Date.now();
    fs.writeFileSync(
      path.join(dir, "meta.json"),
      JSON.stringify(
        {
          skillName: name,
          canonicalSkillName: name,
          providers: [],
          // Provenance travels with the skill, not only in the database:
          // a directory on disk should be able to say where it came from.
          source: { entryId: entry.id, url: entry.sourceUrl, version: entry.version },
          createdAt: now,
          updatedAt: now,
          contentLength: content.length,
        },
        null,
        2,
      ),
      "utf-8",
    );

    return { entryType: "skill", name, location: dir };
  }

  uninstallSkill(rawName: string): boolean {
    const { dir } = this.skillDir(rawName);
    if (!fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }

  listSkills(): InstalledSkill[] {
    const root = path.resolve(this.deps.skillsDir);
    if (!fs.existsSync(root)) return [];
    const out: InstalledSkill[] = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(root, entry.name, "skills.md");
      if (!fs.existsSync(file)) continue;
      out.push({ name: entry.name, path: path.join(root, entry.name), bytes: fs.statSync(file).size });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }
}

/** The real MCP target: McpManager plus the settings row it persists into. */
export function mcpManagerTarget(deps: {
  addServer: (config: McpServerConfig) => void;
  removeServer: (name: string) => Promise<void>;
  getConfig: (name: string) => McpServerConfig | undefined;
  persist: () => void;
}): McpInstallTarget {
  return {
    add(config) {
      deps.addServer(config);
      deps.persist();
    },
    async remove(name) {
      await deps.removeServer(name);
      deps.persist();
    },
    has(name) {
      return deps.getConfig(name) !== undefined;
    },
  };
}
