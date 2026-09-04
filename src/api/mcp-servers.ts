import { del, post, request } from "./core";

export interface McpServerTool {
  name: string;
  description?: string;
}

export type McpTransport = "stdio" | "sse" | "http";

/**
 * A credential named rather than spelled out.
 *
 * Mirrors server/connectors/built-in/mcp/mcp-secrets.ts: a value here is
 * either a literal (fine for NODE_ENV) or a pointer into a vault. A server
 * configured with pointers is started by the runner, which is the only
 * process with a vault session — hence `needsRunner` on the status.
 */
export interface McpSecretRefValue {
  $secret: {
    provider: "vaultwarden" | "protonpass" | "keychain";
    itemRef: string;
    field?: string;
  };
}

export type McpConfigValue = string | McpSecretRefValue;

export function isMcpSecretRef(value: McpConfigValue | undefined): value is McpSecretRefValue {
  return typeof value === "object" && value !== null && "$secret" in value;
}

export interface McpServerStatus {
  name: string;
  label?: string;
  transport: McpTransport;
  connected: boolean;
  tools: McpServerTool[];
  error?: string;
  needsRunner?: boolean;
}

export interface McpServerConfig {
  name: string;
  label?: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, McpConfigValue>;
  url?: string;
  headers?: Record<string, McpConfigValue>;
  enabled: boolean;
  autoConnect: boolean;
  timeout_ms: number;
}

export interface McpServersResponse {
  servers: McpServerStatus[];
}

const BASE = "/api/ops/mcp-servers";

export function fetchMcpServers(): Promise<McpServersResponse> {
  return request<McpServersResponse>(BASE);
}

export function addMcpServer(
  config: McpServerConfig,
): Promise<{ ok: boolean; server?: McpServerStatus; error?: string }> {
  return post<{ ok: boolean; server?: McpServerStatus; error?: string }>(BASE, config);
}

export function deleteMcpServer(name: string): Promise<{ ok: boolean }> {
  return del<{ ok: boolean }>(`${BASE}/${encodeURIComponent(name)}`);
}

export function testMcpServer(name: string): Promise<{ ok: boolean; message: string }> {
  return post<{ ok: boolean; message: string }>(`${BASE}/${encodeURIComponent(name)}/test`);
}

export function connectMcpServer(
  name: string,
): Promise<{ ok: boolean; server?: McpServerStatus; error?: string; message?: string }> {
  return post<{ ok: boolean; server?: McpServerStatus; error?: string; message?: string }>(
    `${BASE}/${encodeURIComponent(name)}/connect`,
  );
}

export function disconnectMcpServer(name: string): Promise<{ ok: boolean }> {
  return post<{ ok: boolean }>(`${BASE}/${encodeURIComponent(name)}/disconnect`);
}
