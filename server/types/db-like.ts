import type { SQLInputValue } from "node:sqlite";
/**
 * Structural database type used across orchestration and route deps.
 *
 * Captures the subset of `node:sqlite#DatabaseSync` actually consumed by these
 * modules (`prepare(sql).{get,all,run}`). Using this structural type instead of
 * the concrete `DatabaseSync` allows test mocks to satisfy the dependency
 * without implementing the full sqlite surface.
 *
 * Existing DbLike inline definitions in `server/contexts/oauth-context.ts`,
 * `server/modules/routes/docs/provider-service.ts`,
 * `server/modules/routes/docs/task-docs-sync.ts`, and
 * `server/modules/routes/ops/token-usage.ts` follow the same shape.
 */
export type DbLike = {
  prepare: (sql: string) => {
    get: (...args: SQLInputValue[]) => unknown;
    all: (...args: SQLInputValue[]) => unknown[];
    run: (...args: SQLInputValue[]) => { changes?: number | bigint } | void;
  };
};
