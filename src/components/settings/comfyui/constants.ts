export type FormState = {
  name: string;
  workflow_type: "text2img" | "img2video" | "custom";
  workflow_json: string;
  parameter_mappings: string;
  default_server_id: string;
};

export const EMPTY_FORM: FormState = {
  name: "",
  workflow_type: "text2img",
  workflow_json: "",
  parameter_mappings: "[]",
  default_server_id: "",
};

export const ROLE_OPTIONS = [
  { key: "positive_prompt", label: "Positive Prompt" },
  { key: "negative_prompt", label: "Negative Prompt" },
  { key: "input_image", label: "Input Image" },
  { key: "num_frames", label: "Frame Count" },
] as const;

export type RoleOptionKey = (typeof ROLE_OPTIONS)[number]["key"];
