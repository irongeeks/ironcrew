/**
 * Iron Command OS — crew configuration.
 *
 * Loads config/departments.yaml and config/agents.seed.yaml, and enforces the
 * separation the product depends on:
 *
 *   professional role   what an agent is competent for
 *   policy              what an agent may do
 *   skin                how an agent looks and sounds
 *
 * POLICY BEATS PERSONA. A character pack may override cosmetic fields only.
 * `applyCharacterPack()` rejects any attempt to reach policy through a skin,
 * because a cosmetic file is exactly where a privilege escalation would be
 * easiest to hide.
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { load as parseYaml } from "js-yaml";
import { z } from "zod";

export const RISK_ORDER = ["low", "medium", "high", "critical"] as const;

export const agentPolicySchema = z
  .object({
    may_delegate: z.boolean().default(false),
    may_create_tasks: z.boolean().default(false),
    /** No agent may ever approve on the owner's behalf. */
    may_approve: z.literal(false).default(false),
    may_veto: z.boolean().default(false),
    max_risk_level: z.enum(RISK_ORDER).default("low"),
    allowed_tools: z.array(z.string()).default([]),
    requires_approval_for: z.array(z.string()).default([]),
  })
  .strict();

export const personaSkinSchema = z
  .object({
    display_name: z.string().min(1),
    accent: z.string().default("cyan"),
    traits: z.array(z.string()).default([]),
    forbidden_traits: z.array(z.string()).default([]),
    portrait: z.string().nullable().default(null),
    full_body: z.string().nullable().default(null),
    model_3d: z.string().nullable().default(null),
  })
  .strict();

export const seedAgentSchema = z
  .object({
    key: z.string().min(1),
    department: z.string().min(1),
    professional_role: z.string().min(1),
    role_summary: z.string().default(""),
    seniority: z.string().default("senior"),
    is_executive_assistant: z.boolean().default(false),
    runtime_profile: z.string().default("balanced"),
    skin: personaSkinSchema,
    policy: agentPolicySchema,
  })
  .strict();

export const crewConfigSchema = z.object({
  version: z.number().int().positive(),
  agents: z.array(seedAgentSchema).min(1),
});

export const departmentConfigSchema = z.object({
  version: z.number().int().positive(),
  departments: z
    .array(
      z.object({
        key: z.string().min(1),
        name: z.string().min(1),
        description: z.string().default(""),
        sort_order: z.number().int().default(0),
      }),
    )
    .min(1),
});

export type AgentPolicy = z.infer<typeof agentPolicySchema>;
export type PersonaSkin = z.infer<typeof personaSkinSchema>;
export type SeedAgent = z.infer<typeof seedAgentSchema>;
export type CrewConfig = z.infer<typeof crewConfigSchema>;
export type DepartmentConfig = z.infer<typeof departmentConfigSchema>;

/** Fields a character pack is permitted to touch. Cosmetic only. */
export const OVERRIDABLE_SKIN_FIELDS = ["display_name", "accent", "portrait", "full_body", "model_3d"] as const;

export class CharacterPackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CharacterPackError";
  }
}

/**
 * Apply a private character pack to a crew config.
 *
 * Only the fields in OVERRIDABLE_SKIN_FIELDS may be changed. Anything else —
 * a policy block, a tool list, a role, or even a trait list — is rejected
 * loudly rather than ignored, so a malformed or malicious pack cannot silently
 * change what an agent is allowed to do.
 */
export function applyCharacterPack(
  crew: CrewConfig,
  pack: { overrides?: Record<string, Record<string, unknown>> } | null | undefined,
): CrewConfig {
  if (!pack?.overrides) return crew;

  const agents = crew.agents.map((agent) => {
    const override = pack.overrides![agent.key];
    if (!override) return agent;

    for (const key of Object.keys(override)) {
      if (!(OVERRIDABLE_SKIN_FIELDS as readonly string[]).includes(key)) {
        throw new CharacterPackError(
          `Character pack for agent "${agent.key}" tried to override "${key}". ` +
            `A character pack is cosmetic: only ${OVERRIDABLE_SKIN_FIELDS.join(", ")} may be set. ` +
            `Policy, tools and roles cannot be changed through a skin.`,
        );
      }
    }

    return { ...agent, skin: personaSkinSchema.parse({ ...agent.skin, ...override }) };
  });

  return { ...crew, agents };
}

/** Numeric rank for risk comparison. */
export function riskRank(level: string): number {
  const i = (RISK_ORDER as readonly string[]).indexOf(level);
  return i < 0 ? 0 : i;
}

/** True when the agent's policy permits acting at the given risk level. */
export function policyPermitsRisk(policy: AgentPolicy, riskLevel: string): boolean {
  return riskRank(riskLevel) <= riskRank(policy.max_risk_level);
}

/** True when the tool is on the agent's allowlist. Deny by default. */
export function policyPermitsTool(policy: AgentPolicy, tool: string): boolean {
  return policy.allowed_tools.includes(tool);
}

export function parseCrewConfig(raw: unknown): CrewConfig {
  const crew = crewConfigSchema.parse(raw);

  const keys = new Set<string>();
  for (const a of crew.agents) {
    if (keys.has(a.key)) throw new Error(`Duplicate agent key in crew config: ${a.key}`);
    keys.add(a.key);
  }

  const eas = crew.agents.filter((a) => a.is_executive_assistant);
  if (eas.length !== 1) {
    throw new Error(
      `Exactly one agent must be the executive assistant; found ${eas.length}. ` +
        `The CEO has a single central point of contact.`,
    );
  }
  return crew;
}

export function configDir(): string {
  return path.resolve(process.cwd(), "config");
}

export function loadDepartmentConfig(file = path.join(configDir(), "departments.yaml")): DepartmentConfig {
  return departmentConfigSchema.parse(parseYaml(readFileSync(file, "utf8")));
}

export function loadCrewConfig(
  file = path.join(configDir(), "agents.seed.yaml"),
  packFile = path.join(configDir(), "private", "character-pack.local.yaml"),
): CrewConfig {
  const crew = parseCrewConfig(parseYaml(readFileSync(file, "utf8")));
  if (!existsSync(packFile)) return crew;
  const pack = parseYaml(readFileSync(packFile, "utf8")) as { overrides?: Record<string, Record<string, unknown>> };
  return applyCharacterPack(crew, pack);
}

/**
 * Build the guidance block injected into an agent's prompt.
 *
 * Order matters: policy is stated AFTER persona and explicitly declared
 * as overriding it, so a persona instruction cannot be read as licence to
 * ignore a rule.
 */
export function buildAgentGuidance(agent: SeedAgent): string {
  const lines: string[] = [];
  lines.push(`# Rolle: ${agent.professional_role}`);
  if (agent.role_summary) lines.push(agent.role_summary.trim());
  lines.push("");
  lines.push(`# Auftreten (rein stilistisch)`);
  lines.push(`Anzeigename: ${agent.skin.display_name}`);
  if (agent.skin.traits.length) lines.push(`Stil: ${agent.skin.traits.join(", ")}`);
  if (agent.skin.forbidden_traits.length) {
    lines.push(`Unzulässiges Verhalten: ${agent.skin.forbidden_traits.join(", ")}`);
  }
  lines.push("");
  lines.push(`# Verbindliche Regeln (haben Vorrang vor dem Auftreten)`);
  lines.push(`- Das Auftreten ist ausschliesslich Tonalität. Es ändert niemals fachliche,`);
  lines.push(`  rechtliche oder sicherheitsrelevante Regeln.`);
  lines.push(`- Maximales Risikoniveau ohne Freigabe: ${agent.policy.max_risk_level}.`);
  lines.push(`- Erlaubte Werkzeuge: ${agent.policy.allowed_tools.join(", ") || "(keine)"}.`);
  lines.push(`- Freigabepflichtig: ${agent.policy.requires_approval_for.join(", ") || "(keine)"}.`);
  lines.push(`- Freigaben erteilt ausschliesslich der menschliche CEO.`);
  if (!agent.policy.may_delegate) lines.push(`- Keine Delegation an andere Agents.`);
  return lines.join("\n");
}
