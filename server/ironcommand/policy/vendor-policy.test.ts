import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import {
  assertModelAllowed,
  buildOpenRouterProviderPolicy,
  defaultVendorPolicyPath,
  evaluateEndpoint,
  evaluateModel,
  filterModelCatalogue,
  getVendorPolicy,
  loadVendorPolicyFromFile,
  normaliseModelId,
  parseVendorPolicy,
  resetVendorPolicyCache,
  VendorPolicyError,
  type VendorPolicy,
} from "./vendor-policy.ts";

const policy = loadVendorPolicyFromFile(
  path.resolve(process.cwd(), "config", "vendor-policy.yaml"),
);

describe("vendor policy config", () => {
  it("the shipped config validates against the schema", () => {
    expect(policy.version).toBe(1);
    expect(policy.allowed_families.length).toBeGreaterThan(0);
    expect(policy.blocked_families.length).toBeGreaterThan(0);
  });

  it("telemetry is off by default", () => {
    expect(policy.telemetry.enabled).toBe(false);
  });

  it("rejects a structurally invalid policy instead of silently defaulting", () => {
    expect(() => parseVendorPolicy({ version: 1 })).toThrow();
    expect(() => parseVendorPolicy({ ...policy, allowed_families: "openai/*" })).toThrow();
  });

  it("getVendorPolicy loads the repo config and caches it", () => {
    resetVendorPolicyCache();
    const a = getVendorPolicy();
    const b = getVendorPolicy();
    expect(a).toBe(b);
    expect(defaultVendorPolicyPath()).toContain("vendor-policy.yaml");
  });
});

describe("normaliseModelId", () => {
  it("lowercases and collapses interchangeable separators", () => {
    expect(normaliseModelId("  OpenAI/GPT_4o ")).toBe("openai/gpt-4o");
    expect(normaliseModelId("Qwen:72B")).toBe("qwen-72b");
  });
});

describe("allowed model families", () => {
  const allowedExamples = [
    "openai/gpt-4o",
    "anthropic/claude-sonnet-4",
    "google/gemini-2.5-pro",
    "mistralai/mistral-large",
    "meta-llama/llama-3.3-70b-instruct",
  ];
  it.each(allowedExamples)("permits %s", (model) => {
    const decision = evaluateModel(policy, model);
    expect(decision.allowed).toBe(true);
    expect(decision.code).toBe("allowed");
  });

  it("is case-insensitive", () => {
    expect(evaluateModel(policy, "OpenAI/GPT-4O").allowed).toBe(true);
  });
});

describe("blocked vendor families (non-negotiable policy)", () => {
  const blockedExamples: Array<[string, string]> = [
    ["deepseek/deepseek-chat", "deepseek"],
    ["deepseek/deepseek-r1", "deepseek"],
    ["qwen/qwen-2.5-72b-instruct", "qwen"],
    ["alibaba/tongyi-qianwen", "qwen"],
    ["qwen/qwq-32b", "qwen"],
    ["moonshotai/kimi-k2", "moonshot"],
    ["minimax/minimax-01", "minimax"],
    ["z-ai/glm-4.6", "zhipu"],
    ["thudm/chatglm3-6b", "zhipu"],
    ["baichuan-inc/baichuan2-13b", "baichuan"],
    ["01-ai/yi-large", "yi"],
    ["stepfun/step-2-16k", "stepfun"],
    ["tencent/hunyuan-large", "hunyuan"],
    ["bytedance/doubao-pro", "doubao"],
    ["baidu/ernie-4.5", "ernie"],
    ["sensetime/sensechat-5", "sensetime"],
    ["iflytek/sparkdesk-v4", "iflytek"],
    ["internlm/internlm2-20b", "internlm"],
  ];

  it.each(blockedExamples)("blocks %s via rule %s", (model, rule) => {
    const decision = evaluateModel(policy, model);
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("blocked_family");
    expect(decision.matchedRule).toBe(rule);
  });

  it("blocks a re-hosted alias even when the prefix looks allowed", () => {
    // A blocked family smuggled under an allowed-looking vendor prefix.
    const decision = evaluateModel(policy, "openai/deepseek-v3-distill");
    expect(decision.allowed).toBe(false);
    expect(decision.matchedRule).toBe("deepseek");
  });

  it("blocks when the model looks fine but the PROVIDER is blocked", () => {
    const decision = evaluateModel(policy, "openai/gpt-4o", "DeepSeek");
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("blocked_family");
  });

  it("blocklist wins even if an allow pattern would match", () => {
    const crafted: VendorPolicy = {
      ...policy,
      allowed_families: ["*/*", "deepseek/*"],
    };
    expect(evaluateModel(crafted, "deepseek/deepseek-chat").allowed).toBe(false);
  });
});

describe("deny by default", () => {
  it("denies an unknown vendor that is on no list", () => {
    const decision = evaluateModel(policy, "somebody/experimental-model");
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("not_in_allowlist");
  });

  it("denies an empty model id", () => {
    expect(evaluateModel(policy, "").code).toBe("empty_model");
    expect(evaluateModel(policy, "   ").code).toBe("empty_model");
  });

  it("does not let a wildcard cross a path segment", () => {
    // "openai/*" must not match "openai/foo/deepseek"
    expect(evaluateModel(policy, "openai/foo/bar").allowed).toBe(false);
  });
});

describe("assertModelAllowed", () => {
  it("passes silently for permitted models", () => {
    expect(() => assertModelAllowed(policy, "anthropic/claude-sonnet-4")).not.toThrow();
  });

  it("throws a typed error carrying the decision", () => {
    try {
      assertModelAllowed(policy, "deepseek/deepseek-chat");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(VendorPolicyError);
      const e = err as VendorPolicyError;
      expect(e.decision.matchedRule).toBe("deepseek");
      expect(e.modelId).toBe("deepseek/deepseek-chat");
    }
  });
});

describe("catalogue filtering", () => {
  it("splits a dynamic model list into allowed and denied", () => {
    const catalogue = [
      { id: "openai/gpt-4o" },
      { id: "deepseek/deepseek-chat" },
      { id: "anthropic/claude-sonnet-4" },
      { id: "qwen/qwen-max" },
      { id: "unknown/mystery" },
    ];
    const { allowed, denied } = filterModelCatalogue(policy, catalogue);
    expect(allowed.map((m) => m.id)).toEqual(["openai/gpt-4o", "anthropic/claude-sonnet-4"]);
    expect(denied.map((d) => d.model.id)).toEqual([
      "deepseek/deepseek-chat",
      "qwen/qwen-max",
      "unknown/mystery",
    ]);
    expect(denied[0].decision.matchedRule).toBe("deepseek");
  });
});

describe("openrouter routing policy", () => {
  it("pins providers and disables fallbacks", () => {
    const block = buildOpenRouterProviderPolicy(policy);
    expect(block.allow_fallbacks).toBe(false);
    expect(block.only).toEqual(policy.openrouter.allowed_providers);
  });

  it("applies privacy defaults for sensitive tasks", () => {
    const block = buildOpenRouterProviderPolicy(policy, { sensitive: true });
    expect(block.data_collection).toBe("deny");
    expect(block.zdr).toBe(true);
    expect(block.allow_fallbacks).toBe(false);
  });

  it("never lists a blocked vendor among allowed providers", () => {
    for (const provider of policy.openrouter.allowed_providers) {
      expect(evaluateEndpoint(policy, provider).allowed).toBe(true);
    }
  });
});

describe("blocked endpoints", () => {
  beforeEach(() => resetVendorPolicyCache());

  it("blocks the OneManCompany talent market", () => {
    const d = evaluateEndpoint(policy, "https://talent-market.example.com/api/agents");
    expect(d.allowed).toBe(false);
    expect(d.matchedRule).toBe("onemancompany-talent-market");
  });

  it("blocks WeChat endpoints", () => {
    expect(evaluateEndpoint(policy, "https://api.weixin.qq.com/cgi-bin/token").allowed).toBe(false);
  });

  it("permits an ordinary endpoint", () => {
    expect(evaluateEndpoint(policy, "https://api.openai.com/v1/models").allowed).toBe(true);
  });
});
