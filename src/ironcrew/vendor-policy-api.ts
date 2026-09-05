import { request } from "../api/core";
import type { CompanyPolicySnapshot, SaveCompanyPolicyInput } from "../shared/company-policy";
import { requestJson } from "./panel-api";

export interface VendorModelCheck {
  model: string;
  provider: string | null;
  decision: { allowed: boolean; code: string; reason: string; matchedRule?: string };
  revision: number;
  baselineFingerprint: string;
}

export const vendorPolicyApi = {
  load: () => request<CompanyPolicySnapshot>("/api/crew/policies/vendor"),
  save: (input: SaveCompanyPolicyInput) =>
    requestJson<CompanyPolicySnapshot>("/api/crew/policies/vendor", { method: "PUT", body: JSON.stringify(input) }),
  check(model: string, provider?: string): Promise<VendorModelCheck> {
    return requestJson<VendorModelCheck>("/api/crew/policies/vendor/check", {
      method: "POST",
      body: JSON.stringify({ model, ...(provider ? { provider } : {}) }),
    });
  },
};
