/**
 * Typed row helpers for `node:sqlite`.
 *
 * `DatabaseSync` statements return `Record<string, SQLOutputValue>`, which does
 * not structurally overlap with our row interfaces, so a direct `as Row[]` is
 * rejected under the build's stricter project settings.
 *
 * These helpers concentrate the one unavoidable cast in a single place, so the
 * call sites stay readable and no per-query casts drift out of sync.
 *
 * The cast is genuinely unchecked: correctness rests on the SELECT matching the
 * row interface, which the schema in
 * server/modules/bootstrap/migrations/0002-iron-crew-domain.ts pins.
 */

import type { StatementSync } from "node:sqlite";

export function allRows<T>(stmt: StatementSync, ...params: unknown[]): T[] {
  return stmt.all(...(params as never[])) as unknown as T[];
}

export function oneRow<T>(stmt: StatementSync, ...params: unknown[]): T | null {
  return (stmt.get(...(params as never[])) as unknown as T | undefined) ?? null;
}
