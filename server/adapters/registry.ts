import type { ProviderAdapter } from "./adapter-interface.ts";

export class AdapterRegistry {
  private adapters = new Map<string, ProviderAdapter>();

  register(adapter: ProviderAdapter): void {
    this.adapters.set(adapter.providerType, adapter);
  }

  get(providerType: string): ProviderAdapter {
    const adapter = this.adapters.get(providerType);
    if (!adapter) {
      throw new Error(`No adapter registered for provider: ${providerType}`);
    }
    return adapter;
  }

  list(): ProviderAdapter[] {
    return [...this.adapters.values()];
  }

  async listAvailable(): Promise<Array<{ name: string; providerType: string; transport: string; available: boolean }>> {
    const results = [];
    for (const adapter of this.adapters.values()) {
      const env = await adapter.testEnvironment();
      results.push({
        name: adapter.name,
        providerType: adapter.providerType,
        transport: adapter.transport,
        available: env.ok,
      });
    }
    return results;
  }
}
