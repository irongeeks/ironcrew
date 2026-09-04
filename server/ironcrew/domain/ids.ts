import { randomUUID } from "node:crypto";

/**
 * Prefixed, sortable-enough identifiers.
 * The prefix makes IDs self-describing in logs and audit trails, which matters
 * a lot when tracing a correlation id across tasks, runs and events.
 */
export type IdPrefix =
  | "cmp"
  | "dept"
  | "agt"
  | "goal"
  | "prj"
  | "mile"
  | "task"
  | "dep"
  | "run"
  | "evt"
  | "conv"
  | "msg"
  | "apr"
  | "dec"
  | "bud"
  | "cost"
  | "grant"
  | "aud"
  | "mem"
  | "ntf"
  | "secret"
  | "att"
  | "worker"
  | "mtg"
  | "mbx"
  | "mbxa"
  | "mmsg"
  | "mkt"
  | "mki"
  | "turn"
  | "action"
  | "corr";

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

export function newCorrelationId(): string {
  return newId("corr");
}
