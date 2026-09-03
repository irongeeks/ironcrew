import type { LoadedPack } from "./pack-loader.ts";

// ---------------------------------------------------------------------------
// PackRegistry
// ---------------------------------------------------------------------------

export class PackRegistry {
  private packs = new Map<string, LoadedPack>();

  /**
   * Bulk load packs from a PackLoader result.
   * Subsequent calls add or overwrite existing keys.
   */
  load(packs: LoadedPack[]): void {
    for (const pack of packs) {
      this.packs.set(pack.key, pack);
    }
  }

  /**
   * Get a pack by key. Throws if not found.
   */
  get(packKey: string): LoadedPack {
    const pack = this.packs.get(packKey);
    if (!pack) {
      throw new Error(`Pack not found in registry: "${packKey}"`);
    }
    return pack;
  }

  /**
   * List all registered packs.
   */
  list(): LoadedPack[] {
    return Array.from(this.packs.values());
  }

  /**
   * List enabled packs. Currently returns all packs; enabled filtering is a future concern.
   */
  listEnabled(): LoadedPack[] {
    return this.list();
  }
}
