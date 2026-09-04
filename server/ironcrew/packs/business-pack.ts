/**
 * IronCrew — what a trade adds to a company.
 *
 * NOT THE SAME THING AS `server/packs/`
 *
 * That directory holds *workflow* packs, inherited from upstream: multi-phase
 * pipelines with departments and gates. This is a *business* pack: the
 * departments, posts, tools, routines and integrations a particular trade
 * needs. An MSP and a web agency both run workflows; what differs is that one
 * has a Tier-0 separation and a Proxmox cluster and the other has leads and
 * demo sites. Two concepts, two words, two directories.
 *
 * A PACK IS CODE, NOT CONTENT
 *
 * No remote source, no download, no version negotiation. `crew_marketplaces`
 * already covers "fetch something from elsewhere and run it", and that
 * surface carries its own threat model (T-12). A pack is a typed object in
 * this repository, installed by key, so reviewing what a pack does is reading
 * a file rather than trusting a publisher.
 *
 * THE SHAPES ARE THE SHAPES THAT ALREADY EXIST
 *
 * A pack's agents are `SeedAgent`s — the same Zod-validated shape as
 * `config/agents.seed.yaml`, down to `may_approve` being a literal `false`.
 * Its tools are `crew_tools` rows with the same three risk classes. Its
 * routines are `crew_routines` rows. Nothing here invents a parallel model of
 * an agent or a permission, because a second model is a second thing to keep
 * in sync and the copy that drifts is always the one with fewer readers.
 */

import { z } from "zod";
import { seedAgentSchema, type SeedAgent } from "../domain/crew-config.ts";
import { TOOL_RISK_CLASSES } from "../domain/tool-store.ts";

/** A department this pack needs. Matched by key against what already exists. */
export const packDepartmentSchema = z
  .object({
    key: z.string().min(1),
    name: z.string().min(1),
    description: z.string().default(""),
    /** Where it sits in the org chart. Seeded departments use 0…120. */
    sort_order: z.number().int().default(500),
  })
  .strict();

export type PackDepartment = z.infer<typeof packDepartmentSchema>;

/**
 * A tool this pack registers.
 *
 * Registration is not permission: a tool exists so that it *can* be granted,
 * and `ToolStore.resolve()` still fails closed until an owner grants it
 * (docs/TOOLS.md). A pack that granted its own tools would be a pack that
 * decides what agents may do, which is the owner's decision.
 */
export const packToolSchema = z
  .object({
    key: z.string().min(1),
    label: z.string().min(1),
    description: z.string().default(""),
    risk_class: z.enum(TOOL_RISK_CLASSES),
    /** The integration key this tool needs, when it needs one. */
    integration: z.string().optional(),
  })
  .strict();

export type PackTool = z.infer<typeof packToolSchema>;

/**
 * A routine this pack suggests.
 *
 * Installed **disabled**. A pack that started firing routines the moment it
 * was installed would spend the owner's money on work they have not yet read;
 * enabling one is a decision, and it is one click.
 */
export const packRoutineSchema = z
  .object({
    key: z.string().min(1),
    name: z.string().min(1),
    instruction: z.string().min(1),
    interval_minutes: z.number().int().min(1),
  })
  .strict();

export type PackRoutine = z.infer<typeof packRoutineSchema>;

/**
 * An external system this pack can talk to.
 *
 * This is the declaration, not the adapter. It exists so the API can answer
 * "what would this pack need from me" *before* an operator installs it, and
 * "what is actually configured" afterwards — which is the difference between
 * a feature flag and a fake button.
 */
export const packIntegrationSchema = z
  .object({
    key: z.string().min(1),
    label: z.string().min(1),
    /** What it is, in one sentence an operator can act on. */
    summary: z.string().min(1),
    /** Environment variables that switch it on. All required unless optional. */
    env: z.array(z.object({ name: z.string().min(1), optional: z.boolean().default(false) })).default([]),
    /** Where the operator reads about it. A real URL, or nothing. */
    docs_url: z.string().url().optional(),
  })
  .strict();

export type PackIntegration = z.infer<typeof packIntegrationSchema>;

export const businessPackSchema = z
  .object({
    key: z
      .string()
      .min(1)
      .regex(/^[a-z][a-z0-9-]*$/, "A pack key is lowercase, digits and hyphens"),
    version: z.string().min(1),
    label: z.string().min(1),
    /** What this pack is for, in the owner's language. Shown before install. */
    summary: z.string().min(1),
    departments: z.array(packDepartmentSchema).default([]),
    agents: z.array(seedAgentSchema).default([]),
    tools: z.array(packToolSchema).default([]),
    routines: z.array(packRoutineSchema).default([]),
    integrations: z.array(packIntegrationSchema).default([]),
  })
  .strict()
  .superRefine((pack, ctx) => {
    // Every agent must name a department this pack brings — or one of the
    // thirteen the company is seeded with. The installer cannot check the
    // latter without a database, so it checks what it can here: an agent
    // pointing at a department nothing defines is a typo, and a typo that
    // reaches the installer becomes an agent silently attached to no
    // department at all.
    const own = new Set(pack.departments.map((d) => d.key));
    for (const agent of pack.agents) {
      if (!own.has(agent.department) && !SEEDED_DEPARTMENT_KEYS.has(agent.department)) {
        ctx.addIssue({
          code: "custom",
          message: `Agent "${agent.key}" names department "${agent.department}", which this pack does not define and the company is not seeded with.`,
        });
      }
    }
    // A pack's own keys must be unique, or the installer's "ensure by key"
    // would create one object and silently drop the other.
    for (const [what, keys] of [
      ["department", pack.departments.map((d) => d.key)],
      ["agent", pack.agents.map((a) => a.key)],
      ["tool", pack.tools.map((t) => t.key)],
      ["routine", pack.routines.map((r) => r.key)],
      ["integration", pack.integrations.map((i) => i.key)],
    ] as const) {
      const seen = new Set<string>();
      for (const key of keys) {
        if (seen.has(key)) {
          ctx.addIssue({ code: "custom", message: `Duplicate ${what} key "${key}" in pack "${pack.key}".` });
        }
        seen.add(key);
      }
    }
    // A tool naming an integration this pack does not declare would leave the
    // status endpoint unable to say why the tool does not work.
    const integrations = new Set(pack.integrations.map((i) => i.key));
    for (const tool of pack.tools) {
      if (tool.integration && !integrations.has(tool.integration)) {
        ctx.addIssue({
          code: "custom",
          message: `Tool "${tool.key}" needs integration "${tool.integration}", which this pack does not declare.`,
        });
      }
    }
  });

export type BusinessPack = z.infer<typeof businessPackSchema>;

/**
 * The departments every company is seeded with (`config/departments.yaml`).
 *
 * Duplicated here as a constant rather than read from the YAML, because this
 * validation runs at module load in tests with no filesystem assumptions —
 * and because a pack referring to a seeded department is referring to
 * something that has been stable since migration 0002. The pack test asserts
 * the two lists agree, so a change to the YAML cannot drift silently.
 */
export const SEEDED_DEPARTMENT_KEYS = new Set([
  "executive",
  "engineering",
  "infrastructure",
  "security",
  "finance",
  "legal",
  "research",
  "quality",
  "design",
  "marketing",
  "sales",
  "knowledge",
  "automation",
]);

/** Parses and validates a pack definition, throwing with a readable message. */
export function defineBusinessPack(pack: unknown): BusinessPack {
  return businessPackSchema.parse(pack);
}

export type { SeedAgent };
