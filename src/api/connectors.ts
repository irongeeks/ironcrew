const BASE_CONNECTORS = "/api/ops/connectors";
const BASE_BINDINGS = "/api/ops/connector-bindings";

export interface ConnectorCapability {
  name: string;
  description: string;
}

export interface ConnectorInfo {
  name: string;
  capabilities: ConnectorCapability[];
}

export interface ConnectorsResponse {
  connectors: ConnectorInfo[];
}

export interface BindingConfig {
  connector: string;
  timeout_ms?: number;
  max_retries?: number;
  connector_config?: Record<string, unknown>;
}

export interface BindingsResponse {
  bindings: Record<string, BindingConfig>;
}

export interface TestResult {
  ok: boolean;
  message: string;
}

export async function fetchConnectors(): Promise<ConnectorsResponse> {
  const res = await fetch(BASE_CONNECTORS);
  if (!res.ok) throw new Error(`Failed to fetch connectors: ${res.status}`);
  return (await res.json()) as ConnectorsResponse;
}

export async function fetchConnectorBindings(): Promise<BindingsResponse> {
  const res = await fetch(BASE_BINDINGS);
  if (!res.ok) throw new Error(`Failed to fetch connector bindings: ${res.status}`);
  return (await res.json()) as BindingsResponse;
}

export async function updateConnectorBindings(bindings: Record<string, BindingConfig>): Promise<void> {
  const res = await fetch(BASE_BINDINGS, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bindings }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || `Failed to update bindings: ${res.status}`);
  }
}

export async function testConnector(name: string, config: Record<string, unknown>): Promise<TestResult> {
  const res = await fetch(`${BASE_CONNECTORS}/${encodeURIComponent(name)}/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ config }),
  });
  return (await res.json()) as TestResult;
}
