import type { DatabaseSync } from "node:sqlite";
import { DEFAULT_WORKFLOW_PACK_SEEDS } from "../../workflow/packs/definitions.ts";

type DbLike = Pick<DatabaseSync, "prepare">;

export function seedDefaultWorkflowPacks(db: DbLike): void {
  const now = Date.now();
  const upsert = db.prepare(
    `
    INSERT INTO workflow_packs (
      key, name, enabled,
      input_schema_json, prompt_preset_json, qa_rules_json,
      output_template_json, routing_keywords_json, cost_profile_json,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      name = excluded.name,
      enabled = excluded.enabled,
      updated_at = excluded.updated_at
  `,
  );

  for (const pack of DEFAULT_WORKFLOW_PACK_SEEDS) {
    upsert.run(
      pack.key,
      pack.name,
      1,
      JSON.stringify(pack.inputSchema),
      JSON.stringify(pack.promptPreset),
      JSON.stringify(pack.qaRules),
      JSON.stringify(pack.outputTemplate),
      JSON.stringify(pack.routingKeywords),
      JSON.stringify(pack.costProfile),
      now,
      now,
    );
  }
}
