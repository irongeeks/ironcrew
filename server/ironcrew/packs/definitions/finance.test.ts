import { describe, it, expect } from "vitest";
import path from "node:path";
import { businessPackSchema, SEEDED_DEPARTMENT_KEYS } from "../business-pack.ts";
import { configDir, loadCrewConfig } from "../../domain/crew-config.ts";
import { financePack } from "./finance.ts";

// The shipped seed, read the way crew-config.test.ts reads it: point the
// character-pack argument at a file that cannot exist, so a developer's
// private, gitignored skin file cannot make these assertions flaky.
const seed = loadCrewConfig(undefined, path.join(configDir(), "private", "__no_such_pack__.local.yaml"));

/**
 * A cheap German-language check for owner-facing strings.
 *
 * Not a language detector — it counts function words that no English
 * instruction would accumulate. The point is that a future edit that slips an
 * English sentence into a routine (the string the owner actually reads) fails
 * here instead of shipping.
 */
const GERMAN_MARKERS =
  /\b(und|oder|nicht|nichts|kein|keine|der|die|das|den|dem|ich|mir|mich|mit|von|für|auf|ist|sind|wird|werden|sag|sieh|bitte)\b/gi;
function germanWordHits(text: string): number {
  return (text.match(GERMAN_MARKERS) ?? []).length;
}

describe("finance-de business pack", () => {
  it("parses against the pack contract and survives a round trip", () => {
    // `defineBusinessPack` already parsed at module load, so importing at all
    // proves the definition is valid. Re-parsing a clone additionally proves
    // the *output* is a legal input: no default has been filled in a way that
    // the schema would reject on the way back through the installer.
    const again = businessPackSchema.parse(JSON.parse(JSON.stringify(financePack)));
    expect(again).toEqual(financePack);
  });

  it("keeps the identity the installer stores it under", () => {
    expect(financePack.key).toBe("finance-de");
    expect(financePack.version).toBe("1.0.0");
    expect(financePack.label).toBe("Finanzen (Deutschland)");
    expect(germanWordHits(financePack.summary)).toBeGreaterThanOrEqual(3);
  });

  it("defines exactly the five finance posts, all in the seeded finance department", () => {
    expect(financePack.agents.map((a) => a.key)).toEqual([
      "finance-eingangsrechnung",
      "finance-forderungen",
      "finance-belegabgleich",
      "finance-liquiditaet",
      "finance-ustva",
    ]);
    const own = new Set(financePack.departments.map((d) => d.key));
    for (const agent of financePack.agents) {
      expect(own.has(agent.department) || SEEDED_DEPARTMENT_KEYS.has(agent.department)).toBe(true);
    }
  });

  it("never lets an agent approve", () => {
    for (const agent of financePack.agents) {
      expect(agent.policy.may_approve).toBe(false);
      expect(agent.policy.may_delegate).toBe(false);
    }
  });

  it("cannot be edited into a pack whose agent approves", () => {
    // `may_approve` is a literal `false` in the schema (THREAT_MODEL,
    // "Non-negotiable defaults"). This asserts the guard is real rather than
    // trusting that nobody will ever type `true`.
    const mutated = JSON.parse(JSON.stringify(financePack)) as {
      agents: { policy: { may_approve: boolean } }[];
    };
    mutated.agents[0]!.policy.may_approve = true;
    expect(() => businessPackSchema.parse(mutated)).toThrow();
  });

  it("does not collide with the seeded crew", () => {
    const seededAgentKeys = new Set(seed.agents.map((a) => a.key));
    const seededNames = new Set(seed.agents.map((a) => a.skin.display_name));
    for (const agent of financePack.agents) {
      // The pack adds specialists *alongside* the seeded Ledger; a shared key
      // would be an "ensure by key" that overwrites the seeded post instead.
      expect(seededAgentKeys.has(agent.key)).toBe(false);
      expect(seededNames.has(agent.skin.display_name)).toBe(false);
    }
    const ownNames = financePack.agents.map((a) => a.skin.display_name);
    expect(new Set(ownNames).size).toBe(ownNames.length);
    // Red is reserved for error/risk/blocker states in the design system.
    for (const agent of financePack.agents) expect(agent.skin.accent).not.toBe("red");
  });

  it("registers only read-only Lexware queries", () => {
    // Exact, not "contains": the central promise of this pack is that it
    // cannot book or pay, and a future `lexware.book_voucher` slipped into the
    // list must fail here rather than be discovered in production.
    expect(financePack.tools.map((t) => `${t.key}:${t.risk_class}`).sort()).toEqual([
      "lexware.invoice:read",
      "lexware.vouchers:read",
    ]);
    const keys = financePack.tools.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const tool of financePack.tools) {
      expect(tool.risk_class).toBe("read");
      expect(germanWordHits(tool.description)).toBeGreaterThanOrEqual(1);
    }
  });

  it("only names integrations it declares", () => {
    const declared = new Set(financePack.integrations.map((i) => i.key));
    for (const tool of financePack.tools) {
      expect(tool.integration).toBeDefined();
      expect(declared.has(tool.integration!)).toBe(true);
    }
  });

  it("asks the operator for exactly the Lexware variables", () => {
    expect(financePack.integrations.map((i) => i.key)).toEqual(["lexware-office"]);
    const lexware = financePack.integrations[0]!;
    expect(lexware.env).toEqual([
      { name: "LEXWARE_OFFICE_API_KEY", optional: false },
      { name: "LEXWARE_OFFICE_URL", optional: true },
    ]);
  });

  it("lets every agent name only tools that exist", () => {
    // Dotted names are this pack's registry keys; a typo like
    // `lexware.invoices` would produce an allowlist entry that permits
    // nothing, silently, because `policyPermitsTool()` matches exact strings.
    const packTools = new Set(financePack.tools.map((t) => t.key));
    for (const agent of financePack.agents) {
      for (const tool of agent.policy.allowed_tools) {
        if (tool.includes(".")) expect(packTools.has(tool)).toBe(true);
      }
    }
  });

  it("keeps the money and tax gates on the posts that would need them", () => {
    const byKey = new Map(financePack.agents.map((a) => [a.key, a]));
    expect(byKey.get("finance-eingangsrechnung")!.policy.requires_approval_for).toContain("bank_transfer");
    expect(byKey.get("finance-ustva")!.policy.requires_approval_for).toContain("tax_filing");
    expect(byKey.get("finance-forderungen")!.policy.requires_approval_for).toContain("external_customer_commitment");
    for (const agent of financePack.agents) expect(agent.policy.max_risk_level).toBe("low");
  });

  it("suggests a daily, a monthly and a quarterly routine, in German", () => {
    expect(financePack.routines.map((r) => [r.key, r.interval_minutes])).toEqual([
      ["finance-offene-posten-taeglich", 1440],
      ["finance-belegabgleich-monatlich", 43200],
      ["finance-ustva-quartal", 129600],
    ]);
    for (const routine of financePack.routines) {
      // A routine costs tokens every time it fires; anything under an hour is
      // a polling loop somebody will pay for by accident.
      expect(routine.interval_minutes).toBeGreaterThanOrEqual(60);
      expect(routine.instruction.trim().length).toBeGreaterThan(60);
      expect(germanWordHits(routine.instruction)).toBeGreaterThanOrEqual(5);
      expect(routine.name.trim()).not.toBe("");
    }
  });

  it("says in the owner's own words that it does not act", () => {
    const ustva = financePack.agents.find((a) => a.key === "finance-ustva")!;
    // The role_summary is what reaches the prompt (`buildAgentGuidance`), so
    // the "preparation, not tax advice" line has to live there, not only in
    // the file header where no model ever reads it.
    expect(ustva.role_summary).toMatch(/keine steuerliche Beratung/i);
    expect(ustva.skin.forbidden_traits).toContain("gives_tax_advice");
    const invoice = financePack.agents.find((a) => a.key === "finance-eingangsrechnung")!;
    expect(invoice.skin.forbidden_traits).toContain("initiates_payments");
  });
});
