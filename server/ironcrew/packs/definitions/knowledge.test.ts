import { describe, it, expect } from "vitest";
import path from "node:path";
import { businessPackSchema, SEEDED_DEPARTMENT_KEYS } from "../business-pack.ts";
import { configDir, loadCrewConfig } from "../../domain/crew-config.ts";
import { knowledgePack } from "./knowledge.ts";

// Same trick as crew-config.test.ts: a character-pack path that cannot exist,
// so a developer's private skin file cannot make these assertions flaky.
const seed = loadCrewConfig(undefined, path.join(configDir(), "private", "__no_such_pack__.local.yaml"));

/** See finance.test.ts — counts German function words in owner-facing text. */
const GERMAN_MARKERS =
  /\b(und|oder|nicht|nichts|kein|keine|der|die|das|den|dem|ich|mir|mich|mit|von|für|auf|ist|sind|wird|werden|sag|sieh|bitte)\b/gi;
function germanWordHits(text: string): number {
  return (text.match(GERMAN_MARKERS) ?? []).length;
}

describe("knowledge business pack", () => {
  it("parses against the pack contract and survives a round trip", () => {
    const again = businessPackSchema.parse(JSON.parse(JSON.stringify(knowledgePack)));
    expect(again).toEqual(knowledgePack);
  });

  it("keeps the identity the installer stores it under", () => {
    expect(knowledgePack.key).toBe("knowledge");
    expect(knowledgePack.version).toBe("1.0.0");
    expect(germanWordHits(knowledgePack.summary)).toBeGreaterThanOrEqual(3);
  });

  it("defines an archivist and a researcher in the seeded knowledge department", () => {
    expect(knowledgePack.agents.map((a) => a.key)).toEqual(["knowledge-archivar", "knowledge-recherche"]);
    const own = new Set(knowledgePack.departments.map((d) => d.key));
    for (const agent of knowledgePack.agents) {
      expect(own.has(agent.department) || SEEDED_DEPARTMENT_KEYS.has(agent.department)).toBe(true);
    }
  });

  it("never lets an agent approve", () => {
    for (const agent of knowledgePack.agents) {
      expect(agent.policy.may_approve).toBe(false);
      expect(agent.policy.may_delegate).toBe(false);
    }
  });

  it("cannot be edited into a pack whose agent approves", () => {
    const mutated = JSON.parse(JSON.stringify(knowledgePack)) as { agents: { policy: { may_approve: boolean } }[] };
    mutated.agents[0]!.policy.may_approve = true;
    expect(() => businessPackSchema.parse(mutated)).toThrow();
  });

  it("does not collide with the seeded crew", () => {
    const seededAgentKeys = new Set(seed.agents.map((a) => a.key));
    const seededNames = new Set(seed.agents.map((a) => a.skin.display_name));
    for (const agent of knowledgePack.agents) {
      // Added alongside the seeded Archive, never on top of it.
      expect(seededAgentKeys.has(agent.key)).toBe(false);
      expect(seededNames.has(agent.skin.display_name)).toBe(false);
    }
    const ownNames = knowledgePack.agents.map((a) => a.skin.display_name);
    expect(new Set(ownNames).size).toBe(ownNames.length);
    for (const agent of knowledgePack.agents) expect(agent.skin.accent).not.toBe("red");
  });

  it("registers exactly two read-only document tools", () => {
    // Exact and read-only: this pack reads other people's documents, so a
    // `write` or `external` tool here would let untrusted content reach an
    // action. A future `nextcloud.share` must fail this test loudly.
    expect(knowledgePack.tools.map((t) => `${t.key}:${t.risk_class}`).sort()).toEqual([
      "nextcloud.browse:read",
      "paperless.search:read",
    ]);
    const keys = knowledgePack.tools.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const tool of knowledgePack.tools) {
      expect(tool.risk_class).toBe("read");
      expect(germanWordHits(tool.description)).toBeGreaterThanOrEqual(1);
    }
  });

  it("only names integrations it declares", () => {
    const declared = new Set(knowledgePack.integrations.map((i) => i.key));
    for (const tool of knowledgePack.tools) {
      expect(tool.integration).toBeDefined();
      expect(declared.has(tool.integration!)).toBe(true);
    }
  });

  it("asks the operator for exactly the Paperless and Nextcloud variables", () => {
    expect(knowledgePack.integrations.map((i) => i.key)).toEqual(["paperless-ngx", "nextcloud"]);
    const byKey = new Map(knowledgePack.integrations.map((i) => [i.key, i]));
    expect(byKey.get("paperless-ngx")!.env).toEqual([
      { name: "PAPERLESS_URL", optional: false },
      { name: "PAPERLESS_TOKEN", optional: false },
    ]);
    expect(byKey.get("nextcloud")!.env).toEqual([
      { name: "NEXTCLOUD_URL", optional: false },
      { name: "NEXTCLOUD_USER", optional: false },
      { name: "NEXTCLOUD_APP_PASSWORD", optional: false },
    ]);
  });

  it("does not redeclare Obsidian as an integration", () => {
    // The vault is a MemoryProvider (memory/obsidian-provider.ts, wired in
    // server-main.ts via OBSIDIAN_VAULT_PATH). Declaring it here would give an
    // operator two switches for one feature and two places to look when it is
    // off.
    const envNames = knowledgePack.integrations.flatMap((i) => i.env.map((e) => e.name));
    expect(envNames).not.toContain("OBSIDIAN_VAULT_PATH");
    expect(knowledgePack.integrations.map((i) => i.key)).not.toContain("obsidian");
  });

  it("lets every agent name only tools that exist", () => {
    const packTools = new Set(knowledgePack.tools.map((t) => t.key));
    for (const agent of knowledgePack.agents) {
      for (const tool of agent.policy.allowed_tools) {
        if (tool.includes(".")) expect(packTools.has(tool)).toBe(true);
      }
      expect(agent.policy.max_risk_level).toBe("low");
    }
  });

  it("treats every document it reads as somebody else's text", () => {
    const researcher = knowledgePack.agents.find((a) => a.key === "knowledge-recherche")!;
    expect(researcher.skin.forbidden_traits).toContain("follows_instructions_found_in_documents");
    expect(researcher.skin.forbidden_traits).toContain("answers_from_general_knowledge");
    const archivist = knowledgePack.agents.find((a) => a.key === "knowledge-archivar")!;
    expect(archivist.skin.forbidden_traits).toContain("deletes_documents");
  });

  it("suggests one weekly filing sweep, in German", () => {
    expect(knowledgePack.routines.map((r) => [r.key, r.interval_minutes])).toEqual([
      ["knowledge-ablage-woechentlich", 10080],
    ]);
    for (const routine of knowledgePack.routines) {
      expect(routine.interval_minutes).toBeGreaterThanOrEqual(60);
      expect(routine.instruction.trim().length).toBeGreaterThan(60);
      expect(germanWordHits(routine.instruction)).toBeGreaterThanOrEqual(5);
      expect(routine.name.trim()).not.toBe("");
    }
  });
});
