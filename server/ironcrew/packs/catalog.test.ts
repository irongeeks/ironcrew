/**
 * The catalogue, and the one property that keeps Phase 4 honest.
 *
 * "Every integration ships behind a feature flag as a real adapter. No fake
 * buttons." That sentence is only true if three lists agree: what the packs
 * declare, what adapters exist, and what the composition root registers. The
 * first two are asserted here; the third is asserted in the routes tests,
 * where a declared-but-unregistered integration must report itself as not
 * configured rather than as broken.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BUSINESS_PACKS, INTEGRATION_ADAPTERS, findPack, listPackKeys } from "./catalog.ts";
import { businessPackSchema, SEEDED_DEPARTMENT_KEYS } from "./business-pack.ts";
import { loadDepartmentConfig } from "../domain/crew-config.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("the catalogue", () => {
  it("ships the five trades Phase 4 names", () => {
    expect(listPackKeys()).toEqual(["msp", "web-agency", "finance-de", "legal-de", "knowledge"]);
  });

  it("has a unique key per pack", () => {
    expect(new Set(listPackKeys()).size).toBe(BUSINESS_PACKS.length);
  });

  it("finds a pack by key and refuses an unknown one", () => {
    expect(findPack("msp")?.label).toBeTruthy();
    expect(findPack("nope")).toBeNull();
  });

  it("every pack still parses — a definition cannot rot silently", () => {
    for (const pack of BUSINESS_PACKS) {
      expect(businessPackSchema.safeParse(pack).success).toBe(true);
    }
  });
});

describe("no fake buttons", () => {
  it("every integration a pack declares has a real adapter module", () => {
    const adapters = new Set<string>(INTEGRATION_ADAPTERS);
    for (const pack of BUSINESS_PACKS) {
      for (const integration of pack.integrations) {
        expect(adapters.has(integration.key), `pack "${pack.key}" declares integration "${integration.key}"`).toBe(
          true,
        );
      }
    }
  });

  it("every adapter named in the catalogue exists on disk", () => {
    for (const key of INTEGRATION_ADAPTERS) {
      expect(fs.existsSync(path.join(here, "integrations", `${key}.ts`)), `integrations/${key}.ts`).toBe(true);
      expect(fs.existsSync(path.join(here, "integrations", `${key}.test.ts`)), `integrations/${key}.test.ts`).toBe(
        true,
      );
    }
  });

  it("every declared integration names at least one environment variable", () => {
    // An integration with no env is an integration that is always "on", which
    // is the one thing a feature flag must never be.
    for (const pack of BUSINESS_PACKS) {
      for (const integration of pack.integrations) {
        expect(integration.env.length, `${pack.key}/${integration.key}`).toBeGreaterThan(0);
        expect(integration.env.some((e) => !e.optional)).toBe(true);
      }
    }
  });
});

describe("the packs agree with the company they install into", () => {
  it("the seeded-department list matches config/departments.yaml", () => {
    // business-pack.ts keeps this list as a constant so validation needs no
    // filesystem. If the YAML gains or loses a department, this fails rather
    // than letting a pack quietly point at one that no longer exists.
    const fromYaml = new Set(loadDepartmentConfig().departments.map((d) => d.key));
    expect([...SEEDED_DEPARTMENT_KEYS].sort()).toEqual([...fromYaml].sort());
  });

  it("no pack grants itself an approver", () => {
    for (const pack of BUSINESS_PACKS) {
      for (const agent of pack.agents) {
        expect(agent.policy.may_approve, `${pack.key}/${agent.key}`).toBe(false);
      }
    }
  });

  it("no two packs claim the same agent key", () => {
    const seen = new Map<string, string>();
    for (const pack of BUSINESS_PACKS) {
      for (const agent of pack.agents) {
        expect(seen.has(agent.key), `agent "${agent.key}" in both ${seen.get(agent.key)} and ${pack.key}`).toBe(false);
        seen.set(agent.key, pack.key);
      }
    }
  });

  it("no two packs claim the same tool key with different risk", () => {
    const seen = new Map<string, string>();
    for (const pack of BUSINESS_PACKS) {
      for (const tool of pack.tools) {
        const previous = seen.get(tool.key);
        if (previous) expect(previous).toBe(tool.risk_class);
        seen.set(tool.key, tool.risk_class);
      }
    }
  });
});
