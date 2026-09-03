export interface ConnectorCapability {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

export interface ConnectorExecuteResult {
  status: "success" | "error" | "timeout";
  artifacts: Array<{
    path: string;
    type: string;
    metadata?: Record<string, unknown>;
  }>;
  costInfo?: {
    tokens?: number;
    credits?: number;
    durationMs: number;
  };
  error?: string;
}

export interface CapabilityBindingConfig {
  connector: string;
  timeout_ms?: number; // default: 300_000
  max_retries?: number; // default: 0
  connector_config: Record<string, unknown>;
}

export interface Connector {
  name: string;
  capabilities: ConnectorCapability[];
  execute(
    capability: string,
    input: Record<string, unknown>,
    config: Record<string, unknown>,
  ): Promise<ConnectorExecuteResult>;
  getAgentGuidance?(capability: string, config: Record<string, unknown>, lang: string): string;
  testConnection(config: Record<string, unknown>): Promise<{ ok: boolean; message: string }>;
}
