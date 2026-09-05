import type { CompanyConfigurationSnapshot, SaveCompanyConfigurationInput } from "../shared/company-configuration";
import { requestJson } from "./panel-api";

export const configurationApi = {
  load: () => requestJson<CompanyConfigurationSnapshot>("/api/crew/configuration"),
  save: (input: SaveCompanyConfigurationInput) =>
    requestJson<CompanyConfigurationSnapshot>("/api/crew/configuration", {
      method: "PUT",
      body: JSON.stringify(input),
    }),
};
