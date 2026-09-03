import type { Connector } from "../../connector-interface.ts";
import { logger } from "../../../observability/logger.ts";

const log = logger.child({ module: "connectors" });

log.info("Web search connector loaded (stub — configure a provider to enable)");

export const webSearchConnector: Connector = {
  name: "web-search",

  capabilities: [
    {
      name: "web_search",
      description: "Search the web for information on a given query",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query" },
          max_results: { type: "number", description: "Maximum number of results to return" },
        },
        required: ["query"],
      },
      outputSchema: {
        type: "object",
        properties: {
          artifacts: { type: "array" },
        },
      },
    },
  ],

  async execute(): Promise<never> {
    throw new Error("No web search provider configured");
  },

  getAgentGuidance(): string {
    return "Use your built-in web search tools to find information.";
  },

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    return { ok: false, message: "No web search provider configured" };
  },
};
