/**
 * IronCrew — reading an agent after the Vessel × Talent split.
 *
 * An agent row no longer carries its role, policy, persona or runtime; those
 * live in `crew_talents` and `crew_vessels` (migration 0011). But a *resolved*
 * agent still has all of them — that is what an agent is, once its pairing is
 * followed. So this module provides the one join, and every read of an agent
 * goes through it.
 *
 * The joined columns keep their original names on purpose. `professional_role`
 * still means what it always meant; only where it is stored has changed. A
 * consumer asking an agent for its role is asking a fair question, and should
 * not have to know which table answers it.
 *
 * `LEFT JOIN` with `COALESCE`, not `INNER JOIN`: an agent whose talent or
 * vessel is somehow missing should still appear — visibly, with defaults — so
 * a broken pairing shows up in the org chart as an agent to fix rather than as
 * an agent that silently vanished from every list.
 */

/**
 * The full `SELECT … FROM … JOIN …` prefix for reading agents. Append a
 * `WHERE`/`ORDER BY` and bind as usual; table aliases are `a` (agent),
 * `t` (talent) and `v` (vessel).
 */
export const RESOLVED_AGENT_SELECT = `
SELECT
  a.id, a.company_id, a.department_id, a.key, a.display_name,
  a.status, a.status_detail, a.is_executive_assistant,
  a.vessel_id, a.talent_id, a.created_at, a.updated_at,

  COALESCE(t.key, '')               AS talent_key,
  COALESCE(t.professional_role, '') AS professional_role,
  COALESCE(t.role_summary, '')      AS role_summary,
  COALESCE(t.seniority, 'senior')   AS seniority,
  COALESCE(t.policy_json, '{}')     AS policy_json,
  CASE WHEN appearance.agent_id IS NULL THEN COALESCE(t.persona_json, '{}')
  ELSE json_set(COALESCE(t.persona_json, '{}'),
    '$.character_id', appearance.character_id,
    '$.portrait', CASE WHEN appearance.portrait_asset_id IS NULL THEN NULL ELSE '/api/crew/character-assets/' || appearance.portrait_asset_id END,
    '$.full_body', CASE WHEN appearance.full_body_asset_id IS NULL THEN NULL ELSE '/api/crew/character-assets/' || appearance.full_body_asset_id END
  ) END AS persona_json,
  COALESCE(t.skills_json, '[]')     AS skills_json,

  COALESCE(v.key, '')               AS vessel_key,
  COALESCE(v.runtime_provider, 'mock') AS runtime_provider,
  COALESCE(v.model, '')             AS vessel_model,
  COALESCE(v.timeout_ms, 600000)    AS vessel_timeout_ms,
  COALESCE(v.max_retries, 1)        AS vessel_max_retries,
  COALESCE(v.max_concurrency, 1)    AS vessel_max_concurrency
FROM crew_agents a
LEFT JOIN crew_talents t ON t.id = a.talent_id
LEFT JOIN crew_vessels v ON v.id = a.vessel_id
LEFT JOIN crew_agent_appearances appearance ON appearance.agent_id = a.id AND appearance.company_id = a.company_id
`;

/** An agent with its pairing followed. */
export interface ResolvedAgentRow {
  id: string;
  company_id: string;
  department_id: string | null;
  key: string;
  display_name: string;
  status: string;
  status_detail: string;
  is_executive_assistant: number;
  vessel_id: string | null;
  talent_id: string | null;
  created_at: number;
  updated_at: number;

  // From the talent.
  talent_key: string;
  professional_role: string;
  role_summary: string;
  seniority: string;
  policy_json: string;
  persona_json: string;
  skills_json: string;

  // From the vessel. Note what is absent: no permission mode, no tool access.
  // A vessel governs how long and how often a run may take, never what it may
  // do — see migration 0011's header and docs/THREAT_MODEL.md T-01.
  vessel_key: string;
  runtime_provider: string;
  vessel_model: string;
  vessel_timeout_ms: number;
  vessel_max_retries: number;
  vessel_max_concurrency: number;
}
