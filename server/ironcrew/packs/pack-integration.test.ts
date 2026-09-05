import { describe, expect, it, vi, afterEach } from "vitest";
import { integrationFetch, integrationJson, DEFAULT_INTEGRATION_TIMEOUT_MS } from "./pack-integration.ts";
afterEach(() => vi.useRealTimers());
describe("bounded integration transport", () => {
  it("refuses redirects even when an injected caller asks to follow", async () => {
    const transport = vi.fn<typeof fetch>(async () => new Response("{}"));
    await integrationFetch(transport, "https://service.example.test", { redirect: "follow" });
    expect(transport.mock.calls[0]?.[1]?.redirect).toBe("error");
  });
  it("rejects oversized streams and cancels the body", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
      },
      cancel,
    });
    await expect(integrationJson(new Response(body), "Testquelle")).rejects.toThrow(/2 MiB/);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("cancels a body that stalls after response headers", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const promise = integrationJson(new Response(new ReadableStream<Uint8Array>({ cancel })), "Testquelle");
    const rejected = expect(promise).rejects.toThrow(/Zeitüberschreitung/);
    await vi.advanceTimersByTimeAsync(DEFAULT_INTEGRATION_TIMEOUT_MS);
    await rejected;
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("does not echo secrets embedded in non-JSON bodies", async () => {
    await expect(integrationJson(new Response("secret-do-not-echo"), "Testquelle")).rejects.toThrow("kein JSON");
  });
});
