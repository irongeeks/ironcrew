/**
 * What these tests defend.
 *
 * This pack's central claim is an absence: no new tools, no integrations, no
 * new departments, because the builtins and the seeded org chart already cover
 * the trade. An absence is exactly the kind of property that erodes quietly —
 * somebody adds a plausible-looking `analytics` integration whose adapter does
 * not exist, and the settings page grows a button that can never turn green.
 * So the emptiness is asserted, not assumed, and the rest of the crew's
 * vocabulary (seniority, approval types, accents, tool keys) is checked the
 * same way the MSP pack checks it.
 */

import { describe, it, expect } from "vitest";
import path from "node:path";
import { webAgencyPack } from "./web-agency.ts";
import { defineBusinessPack, SEEDED_DEPARTMENT_KEYS } from "../business-pack.ts";
import { configDir, loadCrewConfig } from "../../domain/crew-config.ts";
import { ALWAYS_APPROVAL_REQUIRED } from "../../policy/approval-policy.ts";
import { SENIORITY_LEVELS } from "../../domain/talent-store.ts";

// Registered by the server itself (orchestrator/company.ts). This pack's
// agents are allowed these; declaring them would duplicate a registry row.
const BUILTIN_TOOL_KEYS = ["web.search", "browser.read", "browser.interact", "browser.external"];

// Read past any private character pack, as crew-config.test.ts does, so name
// collisions are measured against what actually ships.
const seedCrew = loadCrewConfig(undefined, path.join(configDir(), "private", "__no_such_pack__.local.yaml"));

const packDepartmentKeys = new Set(webAgencyPack.departments.map((d) => d.key));
const packToolKeys = new Set(webAgencyPack.tools.map((t) => t.key));
const packIntegrationKeys = new Set(webAgencyPack.integrations.map((i) => i.key));

describe("web agency business pack", () => {
  it("parses and identifies itself", () => {
    // Getting here means `defineBusinessPack` accepted it at import time.
    expect(webAgencyPack.key).toBe("web-agency");
    expect(webAgencyPack.version).toBe("1.0.0");
    expect(webAgencyPack.label.length).toBeGreaterThan(0);
    expect(webAgencyPack.summary.length).toBeGreaterThan(0);
  });

  describe("the deliberate absences", () => {
    it("declares no tools of its own", () => {
      // If this fails, read the file header before changing the expectation:
      // `web.search`, `browser.read` and `browser.interact` are builtins, and
      // a pack copy of one is a second row with the same meaning that an
      // install could use to re-enable a tool the owner switched off.
      expect(webAgencyPack.tools).toEqual([]);
    });

    it("declares no integrations", () => {
      // An integration without an adapter is a settings entry that can never
      // report success — a fake button. When a real one arrives it comes with
      // its adapter, its testConnection() and its tests, in a version bump.
      expect(webAgencyPack.integrations).toEqual([]);
    });

    it("adds no departments, because the seeded org chart is an agency's", () => {
      expect(webAgencyPack.departments).toEqual([]);
      // Should a later version add one, it must still sit below the seeded
      // 0…120 band rather than reordering the customer's org chart.
      for (const dept of webAgencyPack.departments) {
        expect(SEEDED_DEPARTMENT_KEYS.has(dept.key)).toBe(false);
        expect(dept.sort_order).toBeGreaterThanOrEqual(500);
      }
    });
  });

  describe("agents", () => {
    it("staffs lead qualification, proposals, SEO and delivery", () => {
      expect(webAgencyPack.agents.map((a) => a.key)).toEqual([
        "web-lead-qualifier",
        "web-proposal-writer",
        "web-seo-analyst",
        "web-site-delivery",
      ]);
    });

    it("gives no agent approval authority", () => {
      for (const agent of webAgencyPack.agents) expect(agent.policy.may_approve).toBe(false);
    });

    it("refuses to parse a pack whose agent claims approval authority", () => {
      const tampered = structuredClone(webAgencyPack) as unknown as {
        agents: { policy: { may_approve: boolean } }[];
      };
      tampered.agents[0].policy.may_approve = true;
      expect(() => defineBusinessPack(tampered)).toThrow();
    });

    it("claims no second executive assistant", () => {
      for (const agent of webAgencyPack.agents) expect(agent.is_executive_assistant).toBe(false);
    });

    it("names a department that exists", () => {
      for (const agent of webAgencyPack.agents) {
        const known = packDepartmentKeys.has(agent.department) || SEEDED_DEPARTMENT_KEYS.has(agent.department);
        expect(known, `agent "${agent.key}" names unknown department "${agent.department}"`).toBe(true);
      }
    });

    it("uses keys and display names nobody else has taken", () => {
      const seedKeys = new Set(seedCrew.agents.map((a) => a.key));
      const seedNames = new Set(seedCrew.agents.map((a) => a.skin.display_name));
      const packKeys = new Set<string>();
      const packNames = new Set<string>();
      for (const agent of webAgencyPack.agents) {
        expect(seedKeys.has(agent.key), `agent key "${agent.key}" collides with the seed crew`).toBe(false);
        expect(
          seedNames.has(agent.skin.display_name),
          `display name "${agent.skin.display_name}" collides with the seed crew`,
        ).toBe(false);
        expect(packKeys.has(agent.key)).toBe(false);
        expect(packNames.has(agent.skin.display_name)).toBe(false);
        expect(agent.skin.display_name).toMatch(/^[A-Z][a-z]+$/);
        packKeys.add(agent.key);
        packNames.add(agent.skin.display_name);
      }
    });

    it("speaks the vocabulary the rest of the crew speaks", () => {
      for (const agent of webAgencyPack.agents) {
        expect(SENIORITY_LEVELS as readonly string[]).toContain(agent.seniority);
        expect(["balanced", "coding", "deep_reasoning", "research", "legal_research"]).toContain(agent.runtime_profile);
        // Red stays reserved for error/risk/blocker states.
        expect(["cyan", "amber"]).toContain(agent.skin.accent);
        expect(agent.role_summary.length).toBeGreaterThan(80);
        expect(agent.role_summary).toMatch(/\b(und|der|die|das|nicht|mit|für)\b/);
      }
    });

    it("names only approval types the approval engine knows", () => {
      for (const agent of webAgencyPack.agents) {
        for (const type of agent.policy.requires_approval_for) {
          expect(
            ALWAYS_APPROVAL_REQUIRED as readonly string[],
            `agent "${agent.key}" requires approval for unknown type "${type}"`,
          ).toContain(type);
        }
      }
    });

    it("grants no agent a tool nothing declares", () => {
      // With `tools: []` this reduces to: every dotted tool an agent may use
      // is a builtin. That is the check that would catch a future agent
      // referring to an integration tool this pack never shipped.
      for (const agent of webAgencyPack.agents) {
        for (const tool of agent.policy.allowed_tools.filter((t) => t.includes("."))) {
          const known = packToolKeys.has(tool) || BUILTIN_TOOL_KEYS.includes(tool);
          expect(known, `agent "${agent.key}" is allowed unknown tool "${tool}"`).toBe(true);
        }
      }
    });

    it("gates every client-facing promise behind the owner", () => {
      // An agency's real risk is a promised scope, date or price — not a
      // server falling over.
      for (const key of ["web-lead-qualifier", "web-proposal-writer", "web-site-delivery"]) {
        const agent = webAgencyPack.agents.find((a) => a.key === key)!;
        expect(agent.policy.requires_approval_for, `agent "${key}" may commit to a customer unapproved`).toContain(
          "external_customer_commitment",
        );
      }
      const proposals = webAgencyPack.agents.find((a) => a.key === "web-proposal-writer")!;
      expect(proposals.policy.requires_approval_for).toEqual(
        expect.arrayContaining(["pricing_or_discount_override", "contract_execution"]),
      );
    });

    it("lets nobody submit a form on a live system unattended", () => {
      // `browser.external` is the step that reaches a real outside system and
      // is approval-gated by risk class; no post here needs it at all.
      for (const agent of webAgencyPack.agents) {
        expect(agent.policy.allowed_tools, `agent "${agent.key}" may submit to external systems`).not.toContain(
          "browser.external",
        );
      }
      // Only delivery drives a browser beyond reading, and only up to `write`.
      const interactors = webAgencyPack.agents
        .filter((a) => a.policy.allowed_tools.includes("browser.interact"))
        .map((a) => a.key);
      expect(interactors).toEqual(["web-site-delivery"]);
    });

    it("keeps ceilings proportionate to the post", () => {
      const byKey = Object.fromEntries(webAgencyPack.agents.map((a) => [a.key, a.policy.max_risk_level]));
      expect(byKey["web-lead-qualifier"]).toBe("low");
      expect(byKey["web-proposal-writer"]).toBe("low");
      expect(byKey["web-seo-analyst"]).toBe("low");
      // Delivery touches a repository and a staging environment; nothing here
      // goes higher than that.
      expect(byKey["web-site-delivery"]).toBe("medium");
      const delivery = webAgencyPack.agents.find((a) => a.key === "web-site-delivery")!;
      expect(delivery.policy.requires_approval_for).toEqual(
        expect.arrayContaining(["production_deployment", "irreversible_data_change"]),
      );
    });
  });

  describe("tools and integrations", () => {
    it("would still keep tool keys unique, dotted and non-builtin", () => {
      // Vacuous today by design; it is the guard that catches the first tool
      // a future version adds.
      const seen = new Set<string>();
      for (const tool of webAgencyPack.tools) {
        expect(seen.has(tool.key), `duplicate tool key "${tool.key}"`).toBe(false);
        seen.add(tool.key);
        expect(tool.key).toMatch(/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/);
        expect(tool.label.length).toBeGreaterThan(0);
        expect(BUILTIN_TOOL_KEYS).not.toContain(tool.key);
        expect(["read", "write", "external"]).toContain(tool.risk_class);
      }
    });

    it("would still require every tool's integration to be declared", () => {
      for (const tool of webAgencyPack.tools) {
        if (!tool.integration) continue;
        expect(
          packIntegrationKeys.has(tool.integration),
          `tool "${tool.key}" needs undeclared integration "${tool.integration}"`,
        ).toBe(true);
      }
      // And no integration that backs nothing — the fake-button check.
      const used = new Set(webAgencyPack.tools.map((t) => t.integration));
      for (const integration of webAgencyPack.integrations) {
        expect(used.has(integration.key), `integration "${integration.key}" backs no tool`).toBe(true);
      }
    });
  });

  describe("routines", () => {
    it("suggests the weekly site check and the lead follow-up sweep", () => {
      expect(webAgencyPack.routines.map((r) => r.key)).toEqual([
        "web-agency.weekly-site-check",
        "web-agency.lead-followup-sweep",
      ]);
    });

    it("never fires more often than hourly, and says something in German", () => {
      for (const routine of webAgencyPack.routines) {
        expect(routine.interval_minutes, `routine "${routine.key}" fires too often`).toBeGreaterThanOrEqual(60);
        expect(routine.name.length).toBeGreaterThan(0);
        expect(routine.instruction.trim().length).toBeGreaterThan(120);
        expect(routine.instruction).toMatch(/\b(und|der|die|das|nicht|mit|für)\b/);
      }
    });

    it("keeps the weekly and daily cadences distinct", () => {
      const byKey = Object.fromEntries(webAgencyPack.routines.map((r) => [r.key, r.interval_minutes]));
      expect(byKey["web-agency.weekly-site-check"]).toBe(10080);
      expect(byKey["web-agency.lead-followup-sweep"]).toBe(1440);
    });

    it("keeps the follow-up sweep a draft, not a send", () => {
      // A routine creates a visible task; the point of this instruction is
      // that the outbound message still goes past the owner.
      const sweep = webAgencyPack.routines.find((r) => r.key === "web-agency.lead-followup-sweep")!;
      expect(sweep.instruction).toMatch(/Verschicke nichts selbst/);
    });
  });
});
