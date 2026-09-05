/** Client tools are local capabilities, never executable code supplied by a model. */
import type { z } from "zod";
import type { RunContext } from "./run-events.ts";

export interface OpenRouterTool {
  name: string;
  description: string;
  inputSchema: z.ZodType;
}

export interface OpenRouterToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type OpenRouterToolAuthorization =
  | { status: "allowed"; approvalId?: string }
  | { status: "denied"; reason: string }
  | { status: "approval_required"; approvalType: string; summary: string; riskLevel?: string; proposedAction?: string };

/** All four operations are required; absence never implies permission. */
export interface OpenRouterToolExecutor {
  /** Only local filesystem tools require a project workspace. */
  readonly workspaceRequired?: boolean;
  listTools(context: RunContext): Promise<OpenRouterTool[]>;
  authorize(call: OpenRouterToolCall, context: RunContext): Promise<OpenRouterToolAuthorization>;
  execute(call: OpenRouterToolCall, context: RunContext): Promise<unknown>;
  /** Receives redacted arguments/results. Must durably audit or reject. */
  audit(
    stage: "requested" | "denied" | "approval_required" | "started" | "completed" | "failed",
    call: OpenRouterToolCall,
    context: RunContext,
    result?: unknown,
  ): Promise<void>;
}
