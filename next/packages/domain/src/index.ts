import { createHash } from "node:crypto";
import type { Json, OrderStatus, Scope } from "../../contracts/src/index.ts";
export class DomainError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message = code, status = 409) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.status = status;
  }
}
export function assert(condition: unknown, code: string, status = 409): asserts condition {
  if (!condition) throw new DomainError(code, code, status);
}
export function sameScope(a: Scope, b: Scope): boolean {
  return (
    a.companyId === b.companyId && a.areaId === b.areaId && a.customerId === b.customerId && a.projectId === b.projectId
  );
}
/** Deterministic JSON canonicalization: ordering alone never changes authorization. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype)
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b, "en"))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(",")}}`;
  throw new DomainError("invalid_json", "Only JSON data may be hashed", 400);
}
export function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
const transitions: Record<OrderStatus, OrderStatus[]> = {
  inbox: ["planning", "ready"],
  planning: ["ready"],
  ready: ["running"],
  running: ["reviewing"],
  reviewing: ["running", "completed"],
  completed: [],
  paused: [],
  blocked: [],
  cancelled: [],
  failed: [],
};
export function assertTransition(from: OrderStatus, to: OrderStatus, resumeState?: OrderStatus): void {
  if (from === to) return;
  const terminal = ["completed", "cancelled", "failed"].includes(from);
  assert(!terminal, "terminal_order");
  assert(
    transitions[from].includes(to) ||
      ["paused", "blocked", "cancelled", "failed"].includes(to) ||
      ((from === "paused" || from === "blocked") && to === resumeState),
    "invalid_order_transition",
  );
}
/** Constraints are deliberately restricted to exact top-level allowed values. */
export function parametersAllowed(args: Json, constraints: Json): boolean {
  if (!constraints || typeof constraints !== "object" || Array.isArray(constraints)) return constraints === null;
  if (!args || typeof args !== "object" || Array.isArray(args)) return Object.keys(constraints).length === 0;
  return Object.entries(constraints).every(
    ([key, expected]) => canonicalJson((args as Record<string, Json>)[key] ?? null) === canonicalJson(expected),
  );
}
