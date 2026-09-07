import { describe, it, expect } from "vitest";
import { estimate, route, usdMicros, type Model } from "../../packages/runtime/src/openrouter.ts";
const model: Model = {
  id: "new-vendor/model",
  name: "New Model",
  context_length: 32000,
  supported_parameters: ["tools"],
  pricing: { prompt: "0.000001", completion: "0.000002" },
};
describe("catalog and cost routing", () => {
  it("keeps incompatible models visible with explained reason", () => {
    const result = route(
      [model, { ...model, id: "no-tools", supported_parameters: [] }],
      { messages: [], tools: [], max_tokens: 100 },
      "1000000",
    );
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[1]?.reason).toBe("tools_not_supported");
    expect(result.selected?.model.id).toBe(model.id);
    expect(result.selected?.samples).toBe(0);
  });
  it("uses exact decimal micros and conservative per-token costs", () => {
    expect(usdMicros("0.0000001")).toBe(1n);
    expect(BigInt(estimate(model, { model: model.id, messages: [], tools: [], max_tokens: 100 }))).toBeGreaterThan(
      1200n,
    );
  });
  it("blocks unknown additional pricing and tiny budget", () => {
    expect(() =>
      estimate(
        { ...model, pricing: { ...model.pricing, image: "0.01" } },
        { model: model.id, messages: [], tools: [], max_tokens: 100 },
      ),
    ).toThrow();
    expect(route([model], { messages: [], tools: [], max_tokens: 100 }, "1").selected).toBeUndefined();
  });
});
