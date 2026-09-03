import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  applyCharacterPack,
  buildAgentGuidance,
  CharacterPackError,
  configDir,
  loadCrewConfig,
  loadDepartmentConfig,
  OVERRIDABLE_SKIN_FIELDS,
  parseCrewConfig,
  policyPermitsRisk,
  policyPermitsTool,
  riskRank,
} from "./crew-config.ts";

// "Shipped configuration" means what config/agents.seed.yaml actually
// commits. A developer's machine may have a private, gitignored
// config/private/character-pack.local.yaml sitting on disk (loadCrewConfig()
// applies it automatically when present, by design) — but that file never
// ships, so these tests must not become flaky depending on whether one
// happens to exist locally. Point at a packFile that can never exist so
// `crew` always reflects only the tracked seed file.
const crew = loadCrewConfig(undefined, path.join(configDir(), "private", "__no_such_pack__.local.yaml"));
const departments = loadDepartmentConfig();

describe("shipped configuration", () => {
  it("validates", () => {
    expect(crew.agents.length).toBeGreaterThan(10);
    expect(departments.departments.length).toBeGreaterThan(5);
  });

  it("assigns every agent to a declared department", () => {
    const keys = new Set(departments.departments.map((d) => d.key));
    for (const a of crew.agents) expect(keys.has(a.department)).toBe(true);
  });

  it("has exactly one executive assistant", () => {
    expect(crew.agents.filter((a) => a.is_executive_assistant)).toHaveLength(1);
  });

  it("gives no agent approval authority", () => {
    for (const a of crew.agents) expect(a.policy.may_approve).toBe(false);
  });

  it("gates every money, tax and contract action behind approval", () => {
    const finance = crew.agents.find((a) => a.key === "finance")!;
    expect(finance.policy.requires_approval_for).toEqual(expect.arrayContaining(["bank_transfer", "tax_filing"]));
    const legal = crew.agents.find((a) => a.key === "legal")!;
    expect(legal.policy.requires_approval_for).toContain("contract_execution");
  });

  it("keeps the finance persona cosmetic while the policy stays strict", () => {
    const finance = crew.agents.find((a) => a.key === "finance")!;
    // The skin may be charming; the policy must not be.
    expect(finance.policy.max_risk_level).toBe("low");
    expect(finance.skin.forbidden_traits).toEqual(
      expect.arrayContaining(["cutting_corners", "aggressive_tax_positions"]),
    );
  });

  it("forbids the legal agent from claiming bar admission", () => {
    const legal = crew.agents.find((a) => a.key === "legal")!;
    expect(legal.skin.forbidden_traits).toContain("claims_bar_admission");
  });

  it("commits no real person or franchise names as display names", () => {
    // The public repo ships original archetypes only.
    const forbidden =
      /cersei|lannister|stark|fury|batman|wayne|goodman|specter|holmes|house|edna|draper|shelby|hermione|granger|scotty|bumblebee|spaulding|superbeasto/i;
    for (const a of crew.agents) {
      expect(a.skin.display_name).not.toMatch(forbidden);
    }
  });

  it("never uses red as a persona accent — red is reserved for error/risk/blocker states", () => {
    // A cosmetic accent must never collide with the one colour the design
    // system uses as a real status signal (docs/ARCHITECTURE.md; command-center.css).
    for (const a of crew.agents) {
      expect(a.skin.accent).not.toBe("red");
    }
  });

  it("rejects a config with no executive assistant", () => {
    const broken = { ...crew, agents: crew.agents.map((a) => ({ ...a, is_executive_assistant: false })) };
    expect(() => parseCrewConfig(broken)).toThrow(/executive assistant/i);
  });

  it("rejects a config with two executive assistants", () => {
    const broken = { ...crew, agents: crew.agents.map((a) => ({ ...a, is_executive_assistant: true })) };
    expect(() => parseCrewConfig(broken)).toThrow(/executive assistant/i);
  });

  it("rejects duplicate agent keys", () => {
    const broken = { ...crew, agents: [...crew.agents, crew.agents[0]] };
    expect(() => parseCrewConfig(broken)).toThrow(/[Dd]uplicate/);
  });

  it("rejects an agent granting itself approval authority", () => {
    const broken = {
      ...crew,
      agents: crew.agents.map((a, i) => (i === 0 ? { ...a, policy: { ...a.policy, may_approve: true } } : a)),
    };
    expect(() => parseCrewConfig(broken)).toThrow();
  });

  it("rejects unknown fields inside a policy block", () => {
    const broken = {
      ...crew,
      agents: crew.agents.map((a, i) => (i === 0 ? { ...a, policy: { ...a.policy, bypass_everything: true } } : a)),
    };
    expect(() => parseCrewConfig(broken)).toThrow();
  });
});

describe("character pack is cosmetic only (policy beats persona)", () => {
  it("applies a display name override", () => {
    const out = applyCharacterPack(crew, { overrides: { ea: { display_name: "Nova" } } });
    expect(out.agents.find((a) => a.key === "ea")!.skin.display_name).toBe("Nova");
  });

  it("applies portrait and accent overrides", () => {
    const out = applyCharacterPack(crew, {
      overrides: { ea: { portrait: "private-assets/x.webp", accent: "violet" } },
    });
    const ea = out.agents.find((a) => a.key === "ea")!;
    expect(ea.skin.portrait).toBe("private-assets/x.webp");
    expect(ea.skin.accent).toBe("violet");
  });

  it("rejects an attempt to widen policy through a skin", () => {
    expect(() => applyCharacterPack(crew, { overrides: { ea: { policy: { may_approve: true } } } })).toThrow(
      CharacterPackError,
    );
  });

  it("rejects an attempt to grant tools through a skin", () => {
    expect(() => applyCharacterPack(crew, { overrides: { finance: { allowed_tools: ["bank_transfer"] } } })).toThrow(
      CharacterPackError,
    );
  });

  it("rejects an attempt to change the professional role", () => {
    expect(() => applyCharacterPack(crew, { overrides: { qa: { professional_role: "chief_executive" } } })).toThrow(
      CharacterPackError,
    );
  });

  it("rejects an attempt to drop forbidden traits", () => {
    expect(() => applyCharacterPack(crew, { overrides: { finance: { forbidden_traits: [] } } })).toThrow(
      CharacterPackError,
    );
  });

  it("leaves policy untouched after a legal override", () => {
    const before = crew.agents.find((a) => a.key === "finance")!.policy;
    const out = applyCharacterPack(crew, { overrides: { finance: { display_name: "Abacus" } } });
    expect(out.agents.find((a) => a.key === "finance")!.policy).toEqual(before);
  });

  it("is a no-op without a pack", () => {
    expect(applyCharacterPack(crew, null)).toEqual(crew);
    expect(applyCharacterPack(crew, {})).toEqual(crew);
  });

  it("permits only the declared cosmetic fields", () => {
    expect(OVERRIDABLE_SKIN_FIELDS).toEqual(["display_name", "accent", "portrait", "full_body", "model_3d"]);
  });
});

describe("policy checks", () => {
  it("ranks risk levels", () => {
    expect(riskRank("low")).toBeLessThan(riskRank("medium"));
    expect(riskRank("high")).toBeLessThan(riskRank("critical"));
    expect(riskRank("nonsense")).toBe(0);
  });

  it("permits action only at or below the agent's ceiling", () => {
    const policy = crew.agents.find((a) => a.key === "finance")!.policy;
    expect(policyPermitsRisk(policy, "low")).toBe(true);
    expect(policyPermitsRisk(policy, "high")).toBe(false);
  });

  it("denies tools by default", () => {
    const policy = crew.agents.find((a) => a.key === "research")!.policy;
    expect(policyPermitsTool(policy, "web_search")).toBe(true);
    expect(policyPermitsTool(policy, "shell_safe")).toBe(false);
    expect(policyPermitsTool(policy, "bank_transfer")).toBe(false);
  });
});

describe("agent guidance prompt", () => {
  const guidance = buildAgentGuidance(crew.agents.find((a) => a.key === "finance")!);

  it("states the rules after the persona and marks them as overriding", () => {
    const personaIdx = guidance.indexOf("Auftreten");
    const rulesIdx = guidance.indexOf("Verbindliche Regeln");
    expect(personaIdx).toBeGreaterThan(-1);
    expect(rulesIdx).toBeGreaterThan(personaIdx);
    expect(guidance).toMatch(/haben Vorrang/);
  });

  it("names the approval-gated actions", () => {
    expect(guidance).toContain("bank_transfer");
    expect(guidance).toContain("tax_filing");
  });

  it("states that only the human CEO approves", () => {
    expect(guidance).toMatch(/ausschliesslich der menschliche CEO/);
  });

  it("lists forbidden traits so the persona cannot drift", () => {
    expect(guidance).toContain("cutting_corners");
  });
});
