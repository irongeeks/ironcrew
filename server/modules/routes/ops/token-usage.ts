import { z } from "zod/v4";
import type { RuntimeContext } from "../../../types/runtime-context.ts";
import { requireAuth } from "../../../security/auth.ts";

type DbLike = {
  prepare: (sql: string) => {
    all: (...args: unknown[]) => Record<string, unknown>[];
  };
};

export function queryTokenUsageByTask(db: DbLike, taskId: string) {
  const entries = db.prepare("SELECT * FROM token_usage WHERE task_id = ? ORDER BY recorded_at ASC").all(taskId);

  const totals = entries.reduce<{
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
  }>(
    (acc, row) => ({
      input_tokens: acc.input_tokens + ((row.input_tokens as number) ?? 0),
      output_tokens: acc.output_tokens + ((row.output_tokens as number) ?? 0),
      cache_read_tokens: acc.cache_read_tokens + ((row.cache_read_tokens as number) ?? 0),
      cache_write_tokens: acc.cache_write_tokens + ((row.cache_write_tokens as number) ?? 0),
    }),
    { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
  );

  return { entries, totals };
}

export function queryTokenUsageByProvider(db: DbLike, from?: number, to?: number) {
  let sql = `
    SELECT provider, model,
           SUM(input_tokens) AS total_input,
           SUM(output_tokens) AS total_output,
           COUNT(DISTINCT task_id) AS task_count
    FROM token_usage
  `;
  const params: unknown[] = [];
  const conditions: string[] = [];
  if (from) {
    conditions.push("recorded_at >= ?");
    params.push(from);
  }
  if (to) {
    conditions.push("recorded_at <= ?");
    params.push(to);
  }
  if (conditions.length) sql += " WHERE " + conditions.join(" AND ");
  sql += " GROUP BY provider, model ORDER BY total_input DESC";

  const rows = db.prepare(sql).all(...params);
  return { providers: rows };
}

export function queryTokenUsageByAgent(db: DbLike, agentId: string) {
  const tasks = db
    .prepare(
      `SELECT task_id, provider, model,
              SUM(input_tokens) AS input_tokens,
              SUM(output_tokens) AS output_tokens,
              MAX(recorded_at) AS recorded_at
       FROM token_usage
       WHERE agent_id = ?
       GROUP BY task_id, provider, model
       ORDER BY recorded_at DESC`,
    )
    .all(agentId);

  const totals = tasks.reduce<{ input_tokens: number; output_tokens: number }>(
    (acc, row) => ({
      input_tokens: acc.input_tokens + ((row.input_tokens as number) ?? 0),
      output_tokens: acc.output_tokens + ((row.output_tokens as number) ?? 0),
    }),
    { input_tokens: 0, output_tokens: 0 },
  );

  return { tasks, totals };
}

const BulkTokenUsageBody = z.object({
  agent_ids: z.array(z.string()).max(200).optional(),
});

export function registerTokenUsageRoutes(ctx: RuntimeContext): void {
  const { app, db, adapterRegistry } = ctx;

  app.use("/api/ops/token-usage", requireAuth);

  app.get("/api/ops/token-usage/by-task/:taskId", (req, res) => {
    try {
      const result = queryTokenUsageByTask(db as unknown as DbLike, req.params.taskId);
      res.json(result);
    } catch (err) {
      console.error("[token-usage] query_failed:", err);
      res.status(500).json({ error: "query_failed" });
    }
  });

  app.get("/api/ops/token-usage/by-provider", (req, res) => {
    try {
      const from = req.query.from ? Number(req.query.from) : undefined;
      const to = req.query.to ? Number(req.query.to) : undefined;
      const result = queryTokenUsageByProvider(db as unknown as DbLike, from, to);

      const providers = (result.providers as Record<string, unknown>[]).map((row) => {
        const providerName = row.provider as string;
        let trackingSupported = false;
        try {
          const adapter = adapterRegistry.get(providerName);
          trackingSupported = adapter.supportsTokenTracking;
        } catch {
          // unknown provider
        }
        return { ...row, tracking_supported: trackingSupported };
      });

      res.json({ providers });
    } catch (err) {
      console.error("[token-usage] query_failed:", err);
      res.status(500).json({ error: "query_failed" });
    }
  });

  app.get("/api/ops/token-usage/by-agent/:agentId", (req, res) => {
    try {
      const result = queryTokenUsageByAgent(db as unknown as DbLike, req.params.agentId);
      res.json(result);
    } catch (err) {
      console.error("[token-usage] query_failed:", err);
      res.status(500).json({ error: "query_failed" });
    }
  });

  app.post("/api/ops/token-usage/bulk", (req, res) => {
    try {
      const parsed = BulkTokenUsageBody.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: "validation_failed",
          detail: parsed.error.issues
            .map((i) => (i.path.length > 0 ? i.path.join(".") + ": " : "") + i.message)
            .join("; "),
        });
      }
      const agent_ids = parsed.data.agent_ids;
      if (!Array.isArray(agent_ids) || agent_ids.length === 0) {
        return res.status(400).json({ error: "invalid_body", message: "agent_ids must be a non-empty array" });
      }
      const ids = agent_ids;
      const placeholders = ids.map(() => "?").join(", ");
      const rows = (db as unknown as DbLike)
        .prepare(
          `SELECT agent_id,
                  SUM(input_tokens) AS input_tokens,
                  SUM(output_tokens) AS output_tokens,
                  SUM(cache_read_tokens) AS cache_read_tokens,
                  SUM(cache_write_tokens) AS cache_write_tokens
           FROM token_usage
           WHERE agent_id IN (${placeholders})
           GROUP BY agent_id`,
        )
        .all(...ids);

      const result: Record<
        string,
        { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number }
      > = {};
      for (const row of rows) {
        result[row.agent_id as string] = {
          input_tokens: (row.input_tokens as number) ?? 0,
          output_tokens: (row.output_tokens as number) ?? 0,
          cache_read_tokens: (row.cache_read_tokens as number) ?? 0,
          cache_write_tokens: (row.cache_write_tokens as number) ?? 0,
        };
      }
      res.json({ usage: result });
    } catch (err) {
      console.error("[token-usage] query_failed:", err);
      res.status(500).json({ error: "query_failed" });
    }
  });
}
