import { del, post, request } from "./core";

export interface McpServerTool {
  name: string;
  description?: string;
}

export interface McpServerStatus {
  name: string;
  label?: string;
  transport: "stdio" | "sse";
  connected: boolean;
  tools: McpServerTool[];
  error?: string;
}

export interface McpServerConfig {
  name: string;
  label?: string;
  transport: "stdio" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
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
