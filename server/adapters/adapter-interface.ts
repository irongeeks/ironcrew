import type { PermissionMode } from "../ironcrew/policy/runtime-permissions.ts";

export interface InvocationContext {
  prompt: string;
  workdir: string;
  /**
   * Effective permission mode for this invocation. Resolved by
   * server/ironcrew/policy/runtime-permissions.ts. Adapters must treat an
   * absent value as "restricted" — they must never default to elevated.
   */
  permissionMode?: PermissionMode;
  model?: string;
  reasoningLevel?: string;
  profile?: string;
  maxTurns?: number;
  env?: Record<string, string>;
}

export interface AdapterStreamEvent {
  type: "output" | "tool_use" | "subtask_created" | "subtask_done" | "error" | "token_usage";
  content: string;
  metadata?: Record<string, unknown>;
}

export interface ProviderAdapter {
  name: string;
  providerType: string;
  transport: "cli" | "http";
  supportsTokenTracking: boolean;
  parseStreamChunk(raw: string): AdapterStreamEvent[];
  detectSubtask?(raw: string): { title: string; description: string } | null;
  detectSubtaskDone?(raw: string): { id: string } | null;
  testEnvironment(): Promise<{ ok: boolean; version?: string; message: string }>;
}

export interface CliAdapter extends ProviderAdapter {
  transport: "cli";
  buildArgs(context: InvocationContext): string[];
  promptDelivery: "stdin" | "flag";
  promptFlag?: string;
  /**
   * Flag that names a session/conversation id, when the CLI has one.
   * Adapter-specific rather than assumed: `--session-id` is OpenClaw's, and
   * passing it to a CLI that does not know it turns every run into an
   * unknown-flag error.
   */
  sessionFlag?: string;
}

export interface HttpAdapter extends ProviderAdapter {
  transport: "http";
  buildRequest(
    context: InvocationContext,
    config: Record<string, unknown>,
  ): {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: unknown;
    stream?: boolean;
  };
}

export function isCliAdapter(adapter: ProviderAdapter): adapter is CliAdapter {
  return adapter.transport === "cli";
}
