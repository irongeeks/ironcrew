import type { NodeTypeDefinition } from "./node-type-interface.ts";

/**
 * Registry of all available node types. Built-in node types are registered
 * at server startup in server-main.ts. Community node types are loaded from
 * server/node-types/community/ and override built-in types with the same key.
 */
export class NodeTypeRegistry {
  private types = new Map<string, NodeTypeDefinition>();

  /**
   * Register a node type. If a node type with the same key already exists
   * it is replaced — this is how community node types override built-in ones.
   */
  register(def: NodeTypeDefinition): void {
    this.types.set(def.key, def);
  }

  /**
   * Look up a node type by its key (as used in `node_type:` in pack.yaml).
   * Returns undefined if the key is not registered.
   */
  get(key: string): NodeTypeDefinition | undefined {
    return this.types.get(key);
  }

  /**
   * List all registered node types.
   * Used by GET /api/ops/node-types and the Graph Editor palette.
   */
  list(): NodeTypeDefinition[] {
    return Array.from(this.types.values());
  }
}
