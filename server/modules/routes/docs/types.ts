export type DocsProviderType = "obsidian_local";

export type DocsProviderRow = {
  id: string;
  name: string;
  provider_type: DocsProviderType;
  vault_path: string;
  enabled: number;
  read_only: number;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
};

export type DocsProviderBindingRow = {
  id: string;
  provider_id: string;
  project_id: string | null;
  project_path_prefix: string | null;
  created_at: number;
};

export type DocsProviderView = {
  id: string;
  name: string;
  providerType: DocsProviderType;
  vaultPath: string;
  enabled: boolean;
  readOnly: boolean;
  metadata: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
};

export type DocsNoteSummary = {
  path: string;
  title: string;
  tags: string[];
  links: string[];
  modifiedAt: number;
  size: number;
};

export type DocsSearchResult = {
  path: string;
  title: string;
  score: number;
  snippet: string;
  tags: string[];
  links: string[];
};

export type DocsSkillsProfile = {
  note_taking: string;
  knowledge_retrieval: string;
  document_linking: string;
  tag_management: string;
};

export type TaskDocsContextBundle = {
  contextBlock: string;
  providerIds: string[];
};
