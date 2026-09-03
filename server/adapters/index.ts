import { AdapterRegistry } from "./registry.ts";
import { claudeAdapter } from "./claude.ts";
import { codexAdapter } from "./codex.ts";
import { geminiAdapter } from "./gemini.ts";
import { opencodeAdapter } from "./opencode.ts";
import { openclawAdapter } from "./openclaw.ts";
import { copilotAdapter } from "./copilot.ts";
import { antigravityAdapter } from "./antigravity.ts";

export function createAdapterRegistry(): AdapterRegistry {
  const registry = new AdapterRegistry();
  registry.register(claudeAdapter);
  registry.register(codexAdapter);
  registry.register(geminiAdapter);
  registry.register(opencodeAdapter);
  registry.register(openclawAdapter);
  registry.register(copilotAdapter);
  registry.register(antigravityAdapter);
  return registry;
}

export { AdapterRegistry } from "./registry.ts";
export type {
  ProviderAdapter,
  CliAdapter,
  HttpAdapter,
  InvocationContext,
  AdapterStreamEvent,
} from "./adapter-interface.ts";
export { isCliAdapter } from "./adapter-interface.ts";
