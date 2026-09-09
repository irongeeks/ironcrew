import type { AgentRow } from "../../../types/workflow-types.ts";
import type { RuntimeContext } from "../../../types/runtime-context.ts";
export function agentFixture(overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    id: "agent-fixture",
    name: "Fixture Agent",
    name_ko: "Fixture Agent",
    role: "team_leader",
    personality: null,
    status: "idle",
    department_id: "planning",
    current_task_id: null,
    avatar_emoji: "",
    cli_provider: "codex",
    oauth_account_id: null,
    api_provider_id: null,
    api_model: null,
    cli_model: null,
    cli_reasoning_level: null,
    cli_profile: null,
    ...overrides,
  };
}
export const translations: RuntimeContext["l"] = (ko, en, ja = en, zh = en, de = en) => ({ ko, en, ja, zh, de });
