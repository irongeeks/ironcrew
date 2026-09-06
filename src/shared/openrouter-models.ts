/** Catalog metadata describes discovery, not this installation's runtime capabilities. */
export interface OpenRouterModel {
  id: string;
  name: string;
  contextLength: number | null;
  inputModalities: string[];
  outputModalities: string[];
  supportedParameters: string[];
}

export interface OpenRouterCatalog {
  models: OpenRouterModel[];
  fetchedAt: number;
  stale: boolean;
}
