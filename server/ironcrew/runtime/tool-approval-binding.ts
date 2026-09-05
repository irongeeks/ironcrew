/** Persistent approval identity excludes volatile run/tool-call IDs so a
 * resumed task can present the same action. Arguments are hashed, not stored.
 */
import { createHash } from "node:crypto";
import type { RunContext } from "./run-events.ts";

export const TOOL_APPROVAL_PREFIX = "runtime-tool:v1:";

export function canonicalToolArguments(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalToolArguments).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalToolArguments((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  throw new Error("Tool-Argumente müssen JSON-Werte sein.");
}

export function toolApprovalBinding(context: RunContext, toolKey: string, args: Record<string, unknown>): string {
  const envelope = canonicalToolArguments({
    companyId: context.companyId,
    taskId: context.taskId,
    projectId: context.projectId,
    agentId: context.agentId,
    toolKey,
    arguments: args,
  });
  return `${TOOL_APPROVAL_PREFIX}${createHash("sha256").update(envelope).digest("hex")}`;
}

export function isToolApprovalBinding(value: unknown): value is string {
  return typeof value === "string" && /^runtime-tool:v1:[a-f0-9]{64}$/.test(value);
}
