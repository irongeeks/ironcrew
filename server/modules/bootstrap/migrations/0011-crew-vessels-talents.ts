// server/modules/bootstrap/migrations/0011-crew-vessels-talents.ts
//
// IronCrew — an agent becomes Vessel × Talent.
//
// Until now an agent carried everything itself: what it is competent for, what
// it may do, how it sounds, and which runtime executes it — all inlined on the
// row. Two consequences, both felt:
//
//   * The role "CTO" was defined once per agent, not once. Fourteen agents,
//     fourteen private copies, no reuse.
//   * An agent was welded to one runtime. Moving a role from Claude Code to
//     Codex meant redefining the role.
//
// So the row splits into the two things it was conflating:
//
//   crew_vessels   the execution container — which runtime runs this, with
//                  what timeout, how many retries, how much concurrency.
//   crew_talents   the capability package — professional role, policy,
//                  persona, and the skills it draws on.
//
// `crew_agents` keeps what is genuinely the agent's own: which department it
// sits in, its live status, whether it is the executive assistant — and the
// pairing. An agent is a Vessel × Talent placed in an org.
//
// TWO DELIBERATE DECISIONS
//
// 1. **A vessel cannot set the permission mode, and has no column for it.**
//    That is not an omission to fill in later. CLI permission modes come from
//    a `SandboxGrant` that names the `ApprovalRequest` it came from and is
//    hard-capped at four hours (docs/THREAT_MODEL.md T-01). A vessel field
//    saying `elevated` would be a second route to elevation that no approval
//    ever authorised. A vessel governs how long and how often a run may
//    take — never what it is allowed to do.
//
// 2. **The moved columns are dropped, not left behind.** Keeping them would
//    leave two places claiming to say what an agent's role is, and they would
//    drift the first time someone wrote to the wrong one. The derivation below
//    runs before the drop, inside the migration runner's transaction, so a
//    failure at any point leaves the old shape intact.

import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./migration-types.ts";
import { logger } from "../../../observability/logger.ts";

const log = logger.child({ module: "migrations" });

const SCHEMA = `
CREATE TABLE IF NOT EXISTS crew_vessels (
  id                TEXT PRIMARY KEY,
  company_id        TEXT NOT NULL REFERENCES crew_companies(id) ON DELETE CASCADE,
  key               TEXT NOT NULL,
  label             TEXT NOT NULL DEFAULT '',

  -- Which registered AgentRuntime executes a run in this vessel.
  runtime_provider  TEXT NOT NULL DEFAULT 'mock',
  -- Optional model override; empty means the runtime's own default.
  model             TEXT NOT NULL DEFAULT '',

  -- How long and how often a run may take. This is the whole of a vessel's
  -- authority: no permission mode, no sandbox, no tool access. See the
  -- header comment.
  timeout_ms        INTEGER NOT NULL DEFAULT 600000
                    CHECK (timeout_ms > 0),
  max_retries       INTEGER NOT NULL DEFAULT 1
                    CHECK (max_retries >= 0),
  max_concurrency   INTEGER NOT NULL DEFAULT 1
                    CHECK (max_concurrency >= 1),

  created_at        INTEGER NOT NULL DEFAULT (unixepoch()*1000),
  updated_at        INTEGER NOT NULL DEFAULT (unixepoch()*1000),
  UNIQUE (company_id, key)
);
CREATE INDEX IF NOT EXISTS idx_crew_vessels_company ON crew_vessels(company_id, runtime_provider);

CREATE TABLE IF NOT EXISTS crew_talents (
  id                TEXT PRIMARY KEY,
  company_id        TEXT NOT NULL REFERENCES crew_companies(id) ON DELETE CASCADE,
  key               TEXT NOT NULL,

  -- The three layers that were inlined on crew_agents, unchanged in meaning:
  -- what it is competent for, what it may do, how it sounds.
  professional_role TEXT NOT NULL,
  role_summary      TEXT NOT NULL DEFAULT '',
  seniority         TEXT NOT NULL DEFAULT 'senior',
  policy_json       TEXT NOT NULL DEFAULT '{}',
  persona_json      TEXT NOT NULL DEFAULT '{}',

  -- Names of installed skills this talent draws on (crew_marketplace_installs
  -- with entry_type 'skill'). A JSON array of strings; empty is normal.
  skills_json       TEXT NOT NULL DEFAULT '[]',

  created_at        INTEGER NOT NULL DEFAULT (unixepoch()*1000),
  updated_at        INTEGER NOT NULL DEFAULT (unixepoch()*1000),
  UNIQUE (company_id, key)
);
CREATE INDEX IF NOT EXISTS idx_crew_talents_company ON crew_talents(company_id, professional_role);

-- The pairing. ON DELETE RESTRICT rather than CASCADE or SET NULL: deleting a
-- talent that agents still hold should fail loudly, not silently strip the
-- agents of their role or delete people because a role was tidied away.
ALTER TABLE crew_agents ADD COLUMN vessel_id TEXT REFERENCES crew_vessels(id) ON DELETE RESTRICT;
ALTER TABLE crew_agents ADD COLUMN talent_id TEXT REFERENCES crew_talents(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_crew_agents_vessel ON crew_agents(vessel_id);
CREATE INDEX IF NOT EXISTS idx_crew_agents_talent ON crew_agents(talent_id);
`;

/** Prefixed ids, matching domain/ids.ts without importing across the boundary. */
function newId(prefix: string, seed: number): string {
  return `${prefix}_${seed.toString(16).padStart(8, "0")}${"0".repeat(16)}`;
}

interface AgentSeedRow {
  id: string;
  company_id: string;
  key: string;
  professional_role: string;
  role_summary: string;
  seniority: string;
  policy_json: string;
  persona_json: string;
  runtime_provider: string;
}

/**
 * Moves every existing agent into the new shape.
 *
 * One talent per agent, keyed by the agent's own key: each of the seed crew
 * has a role of its own, and inventing shared talents by comparing JSON would
 * merge two roles that merely look alike today. Agents that should share a
 * talent can be pointed at one afterwards — that is the capability this
 * migration creates, not a guess it should make.
 *
 * One vessel per distinct runtime provider in use, which is the grouping that
 * actually exists in the data.
 */
function derive(db: DatabaseSync): { talents: number; vessels: number; agents: number } {
  const agents = db
    .prepare(
      `SELECT id, company_id, key, professional_role, role_summary, seniority,
              policy_json, persona_json, runtime_provider
         FROM crew_agents ORDER BY company_id, key`,
    )
    .all() as unknown as AgentSeedRow[];

  const insertVessel = db.prepare(
    `INSERT INTO crew_vessels (id, company_id, key, label, runtime_provider) VALUES (?,?,?,?,?)`,
  );
  const insertTalent = db.prepare(
    `INSERT INTO crew_talents
       (id, company_id, key, professional_role, role_summary, seniority, policy_json, persona_json)
     VALUES (?,?,?,?,?,?,?,?)`,
  );
  const bind = db.prepare(`UPDATE crew_agents SET vessel_id = ?, talent_id = ? WHERE id = ?`);

  const vesselIds = new Map<string, string>(); // `${companyId}:${provider}` -> vessel id
  let seq = 0;
  let talents = 0;
  let vessels = 0;

  for (const agent of agents) {
    const provider = agent.runtime_provider || "mock";
    const vesselKey = `${agent.company_id}:${provider}`;
    let vesselId = vesselIds.get(vesselKey);
    if (!vesselId) {
      vesselId = newId("vsl", seq++);
      insertVessel.run(vesselId, agent.company_id, provider, `${provider} (Standard)`, provider);
      vesselIds.set(vesselKey, vesselId);
      vessels++;
    }

    const talentId = newId("tal", seq++);
    insertTalent.run(
      talentId,
      agent.company_id,
      agent.key,
      agent.professional_role,
      agent.role_summary,
      agent.seniority,
      agent.policy_json,
      agent.persona_json,
    );
    talents++;

    bind.run(vesselId, talentId, agent.id);
  }

  return { talents, vessels, agents: agents.length };
}

/**
 * Removes the columns whose content now lives in crew_talents / crew_vessels,
 * plus `runtime_profile` — which was stored, passed around and served over the
 * API without ever being read by anything. It was meant to be the vessel and
 * never became one; the vessel exists now, so the placeholder goes.
 */
const DROP_MOVED_COLUMNS = `
ALTER TABLE crew_agents DROP COLUMN professional_role;
ALTER TABLE crew_agents DROP COLUMN role_summary;
ALTER TABLE crew_agents DROP COLUMN seniority;
ALTER TABLE crew_agents DROP COLUMN policy_json;
ALTER TABLE crew_agents DROP COLUMN persona_json;
ALTER TABLE crew_agents DROP COLUMN runtime_profile;
ALTER TABLE crew_agents DROP COLUMN runtime_provider;
`;

export const migration: Migration = {
  version: 11,
  description: "an agent becomes Vessel × Talent: execution container and capability package split apart",
  up(db: DatabaseSync): void {
    db.exec(SCHEMA);
    const counts = derive(db);
    db.exec(DROP_MOVED_COLUMNS);
    log.info({ version: 11, ...counts }, "agents split into vessels and talents");
  },
};
