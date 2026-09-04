/**
 * IronCrew — talents: the capability package an agent is hired as.
 *
 * A talent is the three layers that used to be inlined on every agent row
 * (migration 0011): what it is competent for (professional role), what it may
 * do (policy), and how it sounds (persona) — plus the installed skills it
 * draws on. Defined once, worn by as many agents as the org needs.
 *
 * Two things this store insists on:
 *
 * 1. **Policy and persona are given as objects, never as strings.** The store
 *    serialises them, so there is no path by which malformed JSON reaches the
 *    column and no reader downstream has to defend against a parse failure.
 * 2. **Their contents never reach the audit log.** A persona is prose and a
 *    policy is a permission set; both are long, and the audit chain answers
 *    "who changed which talent, when" — key, role and the names of the
 *    changed fields carry that, contents do not.
 *
 * A talent says what an agent may do; it never says how long a run may take.
 * That is the vessel's half of the split (see vessel-store.ts).
 */

import type { DatabaseSync } from "node:sqlite";
import { newId } from "./ids.ts";
import { allRows, oneRow } from "./sql.ts";
import { appendAuditEvent, type ActorType } from "./audit.ts";

/**
 * The seniority vocabulary the crew already speaks — the distinct values in
 * config/agents.seed.yaml, with the schema's default among them. Deliberately
 * not the `team_leader | senior | junior | intern` set used by the legacy
 * collab modules: that is an agent's *role* there, a different field.
 */
export const SENIORITY_LEVELS = ["chief_of_staff", "executive", "lead", "senior"] as const;
export type Seniority = (typeof SENIORITY_LEVELS)[number];

export function isSeniority(value: unknown): value is Seniority {
  return (SENIORITY_LEVELS as readonly string[]).includes(value as string);
}

export interface TalentRow {
  id: string;
  company_id: string;
  key: string;
  professional_role: string;
  role_summary: string;
  seniority: string;
  policy_json: string;
  persona_json: string;
  skills_json: string;
  created_at: number;
  updated_at: number;
}

const TALENT_COLUMNS = `id, company_id, key, professional_role, role_summary, seniority,
  policy_json, persona_json, skills_json, created_at, updated_at`;

export class TalentMutationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TalentMutationError";
  }
}

export interface TalentInput {
  companyId: string;
  key: string;
  professionalRole: string;
  roleSummary?: string;
  seniority?: string;
  policy?: Record<string, unknown>;
  persona?: Record<string, unknown>;
  skills?: string[];
}

/** `companyId` and `key` are identity, not settings — a talent is not renamed. */
export type TalentPatch = Partial<Omit<TalentInput, "companyId" | "key">>;

export interface TalentActor {
  actorType?: ActorType;
  actorId?: string;
}

/**
 * The only writable columns, and the only fields a patch is read for. As in
 * VesselStore, `update()` walks this map rather than the caller's object, so
 * an unexpected key from a JSON body never reaches the SET clause.
 */
const PATCH_COLUMNS: Record<keyof TalentPatch, string> = {
  professionalRole: "professional_role",
  roleSummary: "role_summary",
  seniority: "seniority",
  policy: "policy_json",
  persona: "persona_json",
  skills: "skills_json",
};

const DEFAULT_SENIORITY: Seniority = "senior";

function assertSeniority(value: string): void {
  if (!isSeniority(value)) {
    throw new TalentMutationError(`Unbekannte Seniorität "${value}". Erlaubt sind: ${SENIORITY_LEVELS.join(", ")}.`);
  }
}

/** Skill names index into crew_marketplace_installs; an empty name indexes nothing. */
function encodeSkills(skills: string[]): string {
  if (!Array.isArray(skills)) throw new TalentMutationError("Skills müssen als Liste übergeben werden.");
  for (const skill of skills) {
    if (typeof skill !== "string" || !skill.trim()) {
      throw new TalentMutationError("Jeder Skill muss ein nicht-leerer Name sein.");
    }
  }
  return JSON.stringify(skills.map((s) => s.trim()));
}

export class TalentStore {
  constructor(private readonly db: DatabaseSync) {}

  create(input: TalentInput, opts: TalentActor = {}): TalentRow {
    const key = input.key.trim();
    const professionalRole = input.professionalRole.trim();
    if (!key) throw new TalentMutationError("Ein Talent braucht einen Key.");
    if (!professionalRole) throw new TalentMutationError("Ein Talent braucht eine Rolle.");
    // Checked before the INSERT so the owner reads a sentence instead of
    // "UNIQUE constraint failed: crew_talents.company_id, crew_talents.key".
    if (this.byKey(input.companyId, key)) {
      throw new TalentMutationError(`Ein Talent mit dem Key "${key}" existiert in dieser Firma bereits.`);
    }

    const seniority = input.seniority ?? DEFAULT_SENIORITY;
    assertSeniority(seniority);

    const id = newId("tal");
    this.db
      .prepare(
        `INSERT INTO crew_talents
           (id, company_id, key, professional_role, role_summary, seniority,
            policy_json, persona_json, skills_json)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.companyId,
        key,
        professionalRole,
        input.roleSummary ?? "",
        seniority,
        JSON.stringify(input.policy ?? {}),
        JSON.stringify(input.persona ?? {}),
        encodeSkills(input.skills ?? []),
      );

    appendAuditEvent(this.db, {
      companyId: input.companyId,
      actorType: opts.actorType ?? "owner",
      actorId: opts.actorId ?? "ceo",
      action: "talent.created",
      entityType: "talent",
      entityId: id,
      // Key, role and seniority — never the policy or persona this row carries.
      details: { key, professionalRole, seniority },
    });

    return this.get(id)!;
  }

  get(id: string): TalentRow | null {
    return oneRow<TalentRow>(this.db.prepare(`SELECT ${TALENT_COLUMNS} FROM crew_talents WHERE id = ?`), id);
  }

  byKey(companyId: string, key: string): TalentRow | null {
    return oneRow<TalentRow>(
      this.db.prepare(`SELECT ${TALENT_COLUMNS} FROM crew_talents WHERE company_id = ? AND key = ?`),
      companyId,
      key,
    );
  }

  list(companyId: string): TalentRow[] {
    return allRows<TalentRow>(
      this.db.prepare(`SELECT ${TALENT_COLUMNS} FROM crew_talents WHERE company_id = ? ORDER BY key ASC`),
      companyId,
    );
  }

  /**
   * Applies only the fields present in the patch; an omitted field keeps its
   * stored value. Objects and arrays are serialised here, which is why the
   * columns can never hold anything but valid JSON.
   */
  update(id: string, patch: TalentPatch, opts: TalentActor = {}): TalentRow | null {
    const talent = this.get(id);
    if (!talent) return null;

    const source = patch as Record<string, unknown>;
    const columns: string[] = [];
    const params: unknown[] = [];
    const changed: string[] = [];

    for (const [field, column] of Object.entries(PATCH_COLUMNS) as Array<[keyof TalentPatch, string]>) {
      const value = source[field];
      if (value === undefined) continue;

      let encoded: string;
      if (field === "policy" || field === "persona") {
        encoded = JSON.stringify(value ?? {});
      } else if (field === "skills") {
        encoded = encodeSkills(value as string[]);
      } else {
        encoded = String(value).trim();
        if (field === "seniority") assertSeniority(encoded);
        if (field === "professionalRole" && !encoded) {
          throw new TalentMutationError("Ein Talent braucht eine Rolle.");
        }
      }

      columns.push(`${column} = ?`);
      params.push(encoded);
      changed.push(field);
    }

    // Nothing recognised means nothing written — not even updated_at, and no
    // audit entry for an edit that did not happen.
    if (columns.length === 0) return talent;

    this.db
      .prepare(`UPDATE crew_talents SET ${columns.join(", ")}, updated_at = ? WHERE id = ?`)
      .run(...(params as never[]), Date.now(), id);

    appendAuditEvent(this.db, {
      companyId: talent.company_id,
      actorType: opts.actorType ?? "owner",
      actorId: opts.actorId ?? "ceo",
      action: "talent.updated",
      entityType: "talent",
      entityId: id,
      // Which fields moved, never what they now say.
      details: { key: talent.key, professionalRole: talent.professional_role, fields: changed },
    });
    return this.get(id);
  }

  /**
   * Deleting a talent agents still hold is refused, not cascaded: the FK is
   * ON DELETE RESTRICT precisely so that tidying a role away cannot silently
   * strip agents of theirs. Naming them makes the refusal actionable.
   */
  delete(id: string, opts: TalentActor = {}): void {
    const talent = this.get(id);
    // Nothing to delete and nothing to audit; the caller's intent already holds.
    if (!talent) return;

    const agents = this.agentsFor(id);
    if (agents.length > 0) {
      throw new TalentMutationError(
        `Das Talent "${talent.key}" wird noch von ${agents.length} Agent(en) verwendet ` +
          `(${agents.map((a) => a.key).join(", ")}). Weise diesen Agenten zuerst ein anderes Talent zu.`,
      );
    }

    try {
      this.db.prepare("DELETE FROM crew_talents WHERE id = ?").run(id);
    } catch {
      // The check above answers the ordinary case; this catches an agent bound
      // between the two statements, so a raw constraint error still never
      // reaches the API.
      throw new TalentMutationError(
        `Das Talent "${talent.key}" wird noch von Agenten verwendet und kann nicht gelöscht werden.`,
      );
    }

    appendAuditEvent(this.db, {
      companyId: talent.company_id,
      actorType: opts.actorType ?? "owner",
      actorId: opts.actorId ?? "ceo",
      action: "talent.deleted",
      entityType: "talent",
      entityId: id,
      details: { key: talent.key, professionalRole: talent.professional_role },
    });
  }

  /** Who would be affected by a change to this talent — and who blocks its deletion. */
  agentsFor(talentId: string): Array<{ id: string; key: string; display_name: string }> {
    return allRows<{ id: string; key: string; display_name: string }>(
      this.db.prepare(`SELECT id, key, display_name FROM crew_agents WHERE talent_id = ? ORDER BY key ASC`),
      talentId,
    );
  }
}
