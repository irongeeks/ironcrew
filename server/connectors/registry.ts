import type { CapabilityBindingConfig, Connector, ConnectorExecuteResult } from "./connector-interface.ts";

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_RETRIES = 0;

export class ConnectorRegistry {
  private connectors = new Map<string, Connector>();
  private bindings = new Map<string, CapabilityBindingConfig>();

  registerConnector(connector: Connector): void {
    this.connectors.set(connector.name, connector);
  }

  setBinding(capability: string, config: CapabilityBindingConfig): void {
    this.bindings.set(capability, config);
  }

  hasBinding(capability: string): boolean {
    return this.bindings.has(capability);
  }

  getBinding(capability: string): CapabilityBindingConfig | undefined {
    return this.bindings.get(capability);
  }

  async executeCapability(capability: string, input: Record<string, unknown>): Promise<ConnectorExecuteResult> {
    const binding = this.bindings.get(capability);
    if (!binding) {
      throw new Error(`No binding found for capability: "${capability}"`);
    }

    const connector = this.connectors.get(binding.connector);
    if (!connector) {
      throw new Error(`Connector "${binding.connector}" not registered`);
    }

    const timeoutMs = binding.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    const maxRetries = binding.max_retries ?? DEFAULT_MAX_RETRIES;

    let lastResult: ConnectorExecuteResult | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const result = await this.executeWithTimeout(connector, capability, input, binding.connector_config, timeoutMs);

      if (result.status === "success") {
        return result;
      }

      lastResult = result;

      // Only retry on timeout — permanent errors (invalid input, auth) should not be retried
      if (result.status === "error") {
        break;
      }
    }

    return lastResult ?? { status: "error" as const, artifacts: [], error: "No execution attempts were made" };
  }

  private executeWithTimeout(
    connector: Connector,
    capability: string,
    input: Record<string, unknown>,
    config: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<ConnectorExecuteResult> {
    let timer: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<ConnectorExecuteResult>((resolve) => {
      timer = setTimeout(
        () =>
          resolve({
            status: "timeout",
            artifacts: [],
            error: `Capability "${capability}" timed out after ${timeoutMs}ms`,
          }),
        timeoutMs,
      );
    });

    return Promise.race([
      connector.execute(capability, input, config).finally(() => clearTimeout(timer!)),
      timeoutPromise,
    ]);
  }

  getAgentGuidance(capability: string, lang: string): string | null {
    const binding = this.bindings.get(capability);
    if (!binding) return null;

    const connector = this.connectors.get(binding.connector);
    if (!connector?.getAgentGuidance) return null;

    return connector.getAgentGuidance(capability, binding.connector_config, lang);
  }

  getAvailableConnectors(capability: string): Connector[] {
    return Array.from(this.connectors.values()).filter((c) => c.capabilities.some((cap) => cap.name === capability));
  }

  listAll(): Connector[] {
    return [...this.connectors.values()];
  }

  getConnector(name: string): Connector | undefined {
    return this.connectors.get(name);
  }

  unregisterConnector(name: string): void {
    this.connectors.delete(name);
  }

  removeBinding(capability: string): void {
    this.bindings.delete(capability);
  }

  removeBindingsByConnector(connectorName: string): void {
    for (const [cap, config] of this.bindings) {
      if (config.connector === connectorName) {
        this.bindings.delete(cap);
      }
    }
  }
}
