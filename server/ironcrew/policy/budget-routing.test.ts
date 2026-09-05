import type { DatabaseSync } from "node:sqlite";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { createTestDb, seedCompany } from "../domain/test-db.ts";
import { BudgetEngine, BudgetExceededError, type BudgetScopeType } from "./budget-engine.ts";
import { verifyAuditChain } from "../domain/audit.ts";
let db: DatabaseSync;
let budgets: BudgetEngine;
let companyId: string;
const dims = { runtimeType: "openrouter", originRuntimeType: "claude", provider: "openrouter", modelVendor: "openai" };
beforeEach(() => {
  db = createTestDb();
  companyId = seedCompany(db);
  budgets = new BudgetEngine(db);
});
afterEach(() => db.close());
const set = (scopeType: BudgetScopeType, scopeId: string, limitMicros = 1000) =>
  budgets.setBudget({ companyId, scopeType, scopeId, limitMicros, hardStop: true });
describe("budget accounting across profile routing", () => {
  it("charges one cost event to both origin and destination runtime/provider budgets without duplicating company spend", () => {
    const company = set("company", "");
    const original = set("runtime", "claude");
    const selected = set("runtime", "openrouter");
    const transport = set("provider", "openrouter");
    const vendor = set("provider", "openai");
    const recorded = budgets.recordCost({ companyId, ...dims, costMicros: 1000, inputTokens: 10, outputTokens: 2 });
    for (const budget of [company, original, selected, transport, vendor]) expect(budgets.spentFor(budget)).toBe(1000);
    expect(recorded.breached.map((item) => item.budget.id).sort()).toEqual(
      [company, original, selected, transport, vendor].map((budget) => budget.id).sort(),
    );
    expect(
      db
        .prepare("SELECT COUNT(*) AS n,SUM(cost_micros) AS cost FROM crew_cost_events WHERE company_id=?")
        .get(companyId),
    ).toEqual({ n: 1, cost: 1000 });
    expect(verifyAuditChain(db, companyId).valid).toBe(true);
  });
  it.each([
    ["runtime", "claude"],
    ["runtime", "openrouter"],
    ["provider", "openai"],
    ["provider", "openrouter"],
  ] as const)("stops future routed work at a %s %s hard cap", (scope, id) => {
    set(scope, id);
    budgets.recordCost({ companyId, ...dims, costMicros: 1000 });
    expect(() => budgets.assertRunPermitted(companyId, dims)).toThrow(BudgetExceededError);
  });
  it("cannot route around origin spend recorded before routing was configured", () => {
    set("runtime", "claude");
    budgets.recordCost({ companyId, runtimeType: "claude", costMicros: 1000 });
    expect(() => budgets.assertRunPermitted(companyId, dims)).toThrow(/claude/);
  });
  it("does not double-count when the two runtime or provider identities are equal", () => {
    const runtime = set("runtime", "codex");
    const provider = set("provider", "openai");
    budgets.recordCost({
      companyId,
      runtimeType: "codex",
      originRuntimeType: "codex",
      provider: "openai",
      modelVendor: "openai",
      costMicros: 300,
    });
    expect(budgets.spentFor(runtime)).toBe(300);
    expect(budgets.spentFor(provider)).toBe(300);
    expect(
      budgets.status(companyId, {
        runtimeType: "codex",
        originRuntimeType: "codex",
        provider: "openai",
        modelVendor: "openai",
      }),
    ).toHaveLength(2);
  });
  it("keeps zero-money subscription quota honest and scope/window isolation intact", () => {
    const original = set("runtime", "claude");
    const vendor = set("provider", "openai");
    const unrelated = set("provider", "google");
    const foreign = seedCompany(db, "Foreign");
    budgets.recordCost({ companyId: foreign, ...dims, costMicros: 9000 });
    budgets.recordCost({ companyId, ...dims, kind: "quota", costMicros: 9000, inputTokens: 2000 });
    budgets.recordCost({ companyId, ...dims, costMicros: 9000, now: Date.UTC(2000, 0, 1) });
    expect(budgets.spentFor(original)).toBe(0);
    expect(budgets.spentFor(vendor)).toBe(0);
    expect(budgets.spentFor(unrelated)).toBe(0);
    expect(() => budgets.assertRunPermitted(companyId, dims)).not.toThrow();
  });
});
