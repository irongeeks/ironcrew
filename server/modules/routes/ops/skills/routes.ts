import type { RuntimeContext } from "../../../../types/runtime-context.ts";
import { registerSkillCatalogRoutes } from "./catalog-routes.ts";
import { registerSkillLearnRoutes } from "./learn-routes.ts";

export function registerSkillRoutes(ctx: RuntimeContext): {
  normalizeSkillLearnProviders: (input: unknown) => string[];
} {
  registerSkillCatalogRoutes(ctx);
  return registerSkillLearnRoutes(ctx);
}
