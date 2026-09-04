/**
 * What these tests defend.
 *
 * The MSP pack's whole safety argument is a set of properties that are easy to
 * break with a well-meaning one-line edit: every tool read-only, no agent
 * holding approval authority, no post pointing at a department that does not
 * exist, and a vocabulary (seniority, approval types, accents) shared with the
 * rest of the crew. None of that is enforced by the type system — `strict()`
 * catches unknown keys, not wrong values — so it is enforced here, loudly, and
 * a future "just add a restart tool" change fails with a message that says
 * why it is not allowed.
 */

import { describe, it, expect } from "vitest";
import path from "node:path";
import { mspPack } from "./msp.ts";
import { defineBusinessPack, SEEDED_DEPARTMENT_KEYS } from "../business-pack.ts";
import { configDir, loadCrewConfig, loadDepartmentConfig } from "../../domain/crew-config.ts";
import { ALWAYS_APPROVAL_REQUIRED } from "../../policy/approval-policy.ts";
import { SENIORITY_LEVELS } from "../../domain/talent-store.ts";

// The tools this server registers on its own (orchestrator/company.ts). A pack
// agent may be granted one of these without the pack declaring it; anything
// else dotted must come from the pack itself, or the grant would name a tool
// that does not exist.
const BUILTIN_TOOL_KEYS = ["web.search", "browser.read", "browser.interact", "browser.external"];

// The seeded crew, read the way crew-config.test.ts reads it: past any private
// character pack that may happen to sit on a developer's disk, so display-name
// collisions are measured against what actually ships.
const seedCrew = loadCrewConfig(undefined, path.join(configDir(), "private", "__no_such_pack__.local.yaml"));

const packDepartmentKeys = new Set(mspPack.departments.map((d) => d.key));
const packToolKeys = new Set(mspPack.tools.map((t) => t.key));
const packIntegrationKeys = new Set(mspPack.integrations.map((i) => i.key));

describe("MSP business pack", () => {
  it("parses and identifies itself", () => {
    // Reaching this line at all means `defineBusinessPack` accepted the
    // definition — it parses at import time and throws otherwise.
    expect(mspPack.key).toBe("msp");
    expect(mspPack.version).toBe("1.0.0");
    expect(mspPack.label.length).toBeGreaterThan(0);
    expect(mspPack.summary.length).toBeGreaterThan(0);
  });

  it("keeps the seeded department list in sync with config/departments.yaml", () => {
    // business-pack.ts duplicates the seeded keys as a constant so validation
    // needs no filesystem. This is the test that keeps the copy honest.
    const yamlKeys = loadDepartmentConfig().departments.map((d) => d.key);
    expect([...SEEDED_DEPARTMENT_KEYS].sort()).toEqual([...yamlKeys].sort());
  });

  describe("departments", () => {
    it("adds only what the seeded org chart is missing", () => {
      for (const dept of mspPack.departments) {
        expect(SEEDED_DEPARTMENT_KEYS.has(dept.key)).toBe(false);
        expect(dept.name.length).toBeGreaterThan(0);
        expect(dept.description.length).toBeGreaterThan(0);
      }
      // The service desk is the one genuinely missing post-room.
      expect([...packDepartmentKeys]).toEqual(["service-desk"]);
    });

    it("sorts new departments below the seeded ones", () => {
      // Seeded departments occupy 0…120; a pack that squeezed in at 15 would
      // reorder the customer's org chart as a side effect of installing.
      for (const dept of mspPack.departments) expect(dept.sort_order).toBeGreaterThanOrEqual(500);
    });
  });

  describe("agents", () => {
    it("staffs the five posts an MSP actually has", () => {
      expect(mspPack.agents.map((a) => a.key)).toEqual([
        "msp-service-desk",
        "msp-linux-ops",
        "msp-windows-ops",
        "msp-network-ops",
        "msp-backup-monitoring",
      ]);
    });

    it("gives no agent approval authority", () => {
      // The single rule the whole approval engine rests on.
      for (const agent of mspPack.agents) expect(agent.policy.may_approve).toBe(false);
    });

    it("refuses to parse a pack whose agent claims approval authority", () => {
      const tampered = structuredClone(mspPack) as unknown as {
        agents: { policy: { may_approve: boolean } }[];
      };
      tampered.agents[0].policy.may_approve = true;
      expect(() => defineBusinessPack(tampered)).toThrow();
    });

    it("claims no second executive assistant", () => {
      // Exactly one agent company-wide is the CEO's single point of contact
      // (parseCrewConfig enforces it); a pack shipping a second one would
      // break seeding after install rather than at install.
      for (const agent of mspPack.agents) expect(agent.is_executive_assistant).toBe(false);
    });

    it("names a department that exists", () => {
      for (const agent of mspPack.agents) {
        const known = packDepartmentKeys.has(agent.department) || SEEDED_DEPARTMENT_KEYS.has(agent.department);
        expect(known, `agent "${agent.key}" names unknown department "${agent.department}"`).toBe(true);
      }
    });

    it("uses keys and display names nobody else has taken", () => {
      const seedKeys = new Set(seedCrew.agents.map((a) => a.key));
      const seedNames = new Set(seedCrew.agents.map((a) => a.skin.display_name));
      const packKeys = new Set<string>();
      const packNames = new Set<string>();
      for (const agent of mspPack.agents) {
        expect(seedKeys.has(agent.key), `agent key "${agent.key}" collides with the seed crew`).toBe(false);
        expect(
          seedNames.has(agent.skin.display_name),
          `display name "${agent.skin.display_name}" collides with the seed crew`,
        ).toBe(false);
        expect(packKeys.has(agent.key)).toBe(false);
        expect(packNames.has(agent.skin.display_name)).toBe(false);
        // The convention: one evocative word, no spaces.
        expect(agent.skin.display_name).toMatch(/^[A-Z][a-z]+$/);
        packKeys.add(agent.key);
        packNames.add(agent.skin.display_name);
      }
    });

    it("speaks the vocabulary the rest of the crew speaks", () => {
      for (const agent of mspPack.agents) {
        // routes.ts validates seniority against this enum; a value outside it
        // would be seedable but not editable through the API.
        expect(SENIORITY_LEVELS as readonly string[]).toContain(agent.seniority);
        expect(["balanced", "coding", "deep_reasoning", "research", "legal_research"]).toContain(agent.runtime_profile);
        // Red is reserved for error/risk/blocker states; a persona accent must
        // never collide with that signal.
        expect(["cyan", "amber"]).toContain(agent.skin.accent);
        expect(agent.role_summary.length).toBeGreaterThan(80);
        expect(agent.role_summary).toMatch(/\b(und|der|die|das|nicht|mit|für)\b/);
      }
    });

    it("names only approval types the approval engine knows", () => {
      for (const agent of mspPack.agents) {
        for (const type of agent.policy.requires_approval_for) {
          expect(
            ALWAYS_APPROVAL_REQUIRED as readonly string[],
            `agent "${agent.key}" requires approval for unknown type "${type}"`,
          ).toContain(type);
        }
      }
    });

    it("grants no agent a tool nothing declares", () => {
      // Only dotted keys are registry tools; the bare names (file_read,
      // shell_safe, …) are the runtime's own capabilities, as in the seed.
      for (const agent of mspPack.agents) {
        for (const tool of agent.policy.allowed_tools.filter((t) => t.includes("."))) {
          const known = packToolKeys.has(tool) || BUILTIN_TOOL_KEYS.includes(tool);
          expect(known, `agent "${agent.key}" is allowed unknown tool "${tool}"`).toBe(true);
        }
      }
    });

    it("keeps the post closest to Tier 0 on the lowest ceiling", () => {
      const windows = mspPack.agents.find((a) => a.key === "msp-windows-ops")!;
      expect(windows.policy.max_risk_level).toBe("low");
      expect(windows.policy.requires_approval_for).toEqual(
        expect.arrayContaining(["tier0_change", "permission_change"]),
      );
      // Nobody in this pack operates at high risk. An MSP agent at "high" is
      // an agent that can act on a customer's production estate unattended.
      for (const agent of mspPack.agents) {
        expect(["low", "medium"], `agent "${agent.key}" has ceiling "${agent.policy.max_risk_level}"`).toContain(
          agent.policy.max_risk_level,
        );
      }
    });

    it("names the irreversible operations as approval-gated where they apply", () => {
      const linux = mspPack.agents.find((a) => a.key === "msp-linux-ops")!;
      expect(linux.policy.requires_approval_for).toEqual(
        expect.arrayContaining(["production_deployment", "irreversible_data_change", "tier0_change"]),
      );
      const backup = mspPack.agents.find((a) => a.key === "msp-backup-monitoring")!;
      // A restore overwrites live data, whoever runs it.
      expect(backup.policy.requires_approval_for).toContain("irreversible_data_change");
      const desk = mspPack.agents.find((a) => a.key === "msp-service-desk")!;
      expect(desk.policy.requires_approval_for).toContain("external_customer_commitment");
    });
  });

  describe("tools", () => {
    it("declares the read-only sources the posts work from", () => {
      expect(mspPack.tools.map((t) => t.key)).toEqual([
        "proxmox.inventory",
        "proxmox.backup-status",
        "rmm.agents",
        "rmm.alerts",
        "rmm.patch-status",
        "unifi.devices",
        "unifi.clients",
      ]);
    });

    it("ships nothing that can change a customer system", () => {
      // THE Tier-0 assertion. If this test ever fails, the pack has stopped
      // being what its header promises, and the fix is to remove the tool —
      // not to update the expectation. A pack that hands an agent write or
      // external access to a customer's estate has moved that customer's
      // security boundary into a prompt.
      for (const tool of mspPack.tools) {
        expect(tool.risk_class, `tool "${tool.key}" is not read-only`).toBe("read");
      }
    });

    it("keeps tool keys unique, dotted and labelled", () => {
      const seen = new Set<string>();
      for (const tool of mspPack.tools) {
        expect(seen.has(tool.key), `duplicate tool key "${tool.key}"`).toBe(false);
        seen.add(tool.key);
        expect(tool.key).toMatch(/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/);
        expect(tool.label.length).toBeGreaterThan(0);
        expect(tool.description.length).toBeGreaterThan(0);
        // A builtin re-registered by a pack would be a second row with the
        // same meaning, and installing could silently re-enable a tool the
        // owner switched off company-wide.
        expect(BUILTIN_TOOL_KEYS).not.toContain(tool.key);
      }
    });

    it("names only integrations the pack declares", () => {
      for (const tool of mspPack.tools) {
        expect(tool.integration, `tool "${tool.key}" is backed by no integration`).toBeDefined();
        expect(
          packIntegrationKeys.has(tool.integration!),
          `tool "${tool.key}" needs undeclared integration "${tool.integration}"`,
        ).toBe(true);
      }
    });

    it("declares no integration nothing uses", () => {
      // A declared integration with no tool behind it is a settings entry an
      // operator can configure to no effect.
      const used = new Set(mspPack.tools.map((t) => t.integration));
      for (const integration of mspPack.integrations) {
        expect(used.has(integration.key), `integration "${integration.key}" backs no tool`).toBe(true);
      }
    });
  });

  describe("integrations", () => {
    it("declares exactly the three systems, with the agreed environment variables", () => {
      // The env names are a contract with the operator's .env and with the
      // adapters; renaming one here silently breaks a working install.
      const byKey = Object.fromEntries(mspPack.integrations.map((i) => [i.key, i]));
      expect(Object.keys(byKey).sort()).toEqual(["proxmox", "tactical-rmm", "unifi"]);

      expect(byKey["proxmox"].env.map((e) => e.name)).toEqual([
        "PROXMOX_URL",
        "PROXMOX_TOKEN_ID",
        "PROXMOX_TOKEN_SECRET",
      ]);
      expect(byKey["tactical-rmm"].env.map((e) => e.name)).toEqual(["TACTICAL_RMM_URL", "TACTICAL_RMM_API_KEY"]);
      expect(byKey["unifi"].env.map((e) => e.name)).toEqual(["UNIFI_URL", "UNIFI_API_KEY", "UNIFI_SITE"]);

      // Only the UniFi site is optional; everything else is what "configured"
      // means, and defaulting a credential to optional would let the status
      // endpoint report a broken integration as ready.
      const optional = mspPack.integrations.flatMap((i) => i.env.filter((e) => e.optional).map((e) => e.name));
      expect(optional).toEqual(["UNIFI_SITE"]);
    });

    it("tells the operator what each system is for, and where to read up", () => {
      for (const integration of mspPack.integrations) {
        expect(integration.label.length).toBeGreaterThan(0);
        expect(integration.summary.length).toBeGreaterThan(20);
        expect(integration.summary).toMatch(/\b(und|der|die|das|nicht|mit|für|ein|eine)\b/);
        expect(integration.docs_url).toMatch(/^https:\/\//);
      }
    });
  });

  describe("routines", () => {
    it("suggests the recurring work an MSP actually does", () => {
      expect(mspPack.routines.map((r) => r.key)).toEqual([
        "msp.morning-alert-triage",
        "msp.weekly-backup-verification",
        "msp.monthly-patch-eol-review",
      ]);
    });

    it("never fires more often than hourly, and says something in German", () => {
      for (const routine of mspPack.routines) {
        // A routine creates a task on every tick. Sub-hourly intervals turn a
        // suggestion into a board full of duplicates and a bill nobody
        // approved.
        expect(routine.interval_minutes, `routine "${routine.key}" fires too often`).toBeGreaterThanOrEqual(60);
        expect(routine.name.length).toBeGreaterThan(0);
        // The instruction is what the owner would have typed — long enough to
        // be an actual brief, and in the product's language.
        expect(routine.instruction.trim().length).toBeGreaterThan(120);
        expect(routine.instruction).toMatch(/\b(und|der|die|das|nicht|mit|für)\b/);
      }
    });

    it("keeps daily, weekly and monthly cadences distinct", () => {
      const byKey = Object.fromEntries(mspPack.routines.map((r) => [r.key, r.interval_minutes]));
      expect(byKey["msp.morning-alert-triage"]).toBe(1440);
      expect(byKey["msp.weekly-backup-verification"]).toBe(10080);
      expect(byKey["msp.monthly-patch-eol-review"]).toBe(43200);
    });
  });
});
