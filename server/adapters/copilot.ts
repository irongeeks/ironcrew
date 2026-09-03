import type { HttpAdapter, InvocationContext, AdapterStreamEvent } from "./adapter-interface.ts";

export const copilotAdapter: HttpAdapter = {
  name: "GitHub Copilot",
  providerType: "copilot",
  transport: "http",
  supportsTokenTracking: false,

  buildRequest(context: InvocationContext, config: Record<string, unknown>) {
    const apiUrl = (config.apiUrl as string) || "https://api.github.com";

    return {
      url: `${apiUrl}/v1/chat/completions`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: {
        messages: [
          {
            role: "user",
            content: context.prompt,
          },
        ],
      },
      stream: true,
    };
  },

  parseStreamChunk(): AdapterStreamEvent[] {
    // HTTP adapters are not yet connected to a streaming pipeline — the CLI runtime
    // (`cli-runtime.ts`) guards against HTTP adapters with an explicit `isCliAdapter`
    // check and throws before this method is reached. Returning [] is intentional for
    // now, but MUST be implemented (parse SSE/NDJSON chunks into AdapterStreamEvents)
    // when an HTTP streaming runtime is added; otherwise all output will be silently lost.
    return [];
  },

  async testEnvironment(): Promise<{ ok: boolean; message: string }> {
    return {
      ok: false,
      message: "HTTP adapter - not a local CLI",
    };
  },
};
