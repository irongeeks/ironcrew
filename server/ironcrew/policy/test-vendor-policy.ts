/** Test-only opt-in restrictions: enforcement must not depend on the shipped open catalogue. */
import { getVendorPolicy, type VendorPolicy } from "./vendor-policy.ts";

export function restrictiveVendorPolicy(): VendorPolicy {
  const baseline = structuredClone(getVendorPolicy());
  const matches: Record<string, string[]> = {
    deepseek: ["deepseek"],
    qwen: ["qwen", "alibaba", "tongyi", "qwq", "qvq"],
    moonshot: ["moonshot", "kimi"],
    minimax: ["minimax", "abab"],
    zhipu: ["zhipu", "z-ai", "z.ai", "glm", "chatglm", "codegeex"],
    baichuan: ["baichuan"],
    yi: ["01-ai", "01.ai", "yi-large"],
    stepfun: ["stepfun", "step-1", "step-2"],
    hunyuan: ["hunyuan", "tencent"],
    doubao: ["doubao", "bytedance"],
    ernie: ["ernie", "baidu"],
    sensetime: ["sensetime", "sensechat"],
    iflytek: ["iflytek", "sparkdesk"],
    internlm: ["internlm"],
  };
  return {
    ...baseline,
    policy_name: "Explicit test operator restrictions",
    allowed_families: ["openai/*", "anthropic/*", "google/*", "mistralai/*", "meta-llama/*"],
    blocked_families: Object.entries(matches).map(([id, match]) => ({
      id,
      match,
      reason: "Test operator restriction",
    })),
    openrouter: {
      ...baseline.openrouter,
      allowed_providers: ["OpenAI", "Anthropic", "Google", "DeepInfra"],
      allow_fallbacks: false,
    },
  };
}
