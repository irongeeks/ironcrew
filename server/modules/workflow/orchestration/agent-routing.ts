import type { PackRegistry } from "../../../packs/pack-registry.ts";

export function resolveAgentRouting(
  task: { agent_routing: string | null; workflow_pack_key: string | null },
  packRegistry: PackRegistry | null,
): "single" | "department" {
  if (task.agent_routing === "single" || task.agent_routing === "department") {
    return task.agent_routing;
  }
  if (task.workflow_pack_key && packRegistry) {
    try {
      const pack = packRegistry.get(task.workflow_pack_key);
      const packDefault = pack.definition.pack.agent_routing;
      if (packDefault === "single" || packDefault === "department") {
        return packDefault;
      }
    } catch {
      /* pack not found */
    }
  }
  return "department";
}
