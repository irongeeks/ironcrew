export type ParsedNode = {
  nodeId: string;
  classType: string;
  title: string;
  stringInputs: { key: string; value: string }[];
  numericInputs: { key: string; value: number }[];
};

export type RoleAssignment = {
  paramKey: string;
  nodeId: string;
  inputKey: string;
  description: string;
};

export function parseWorkflowNodes(json: string): ParsedNode[] {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return [];
  }

  const nodes: ParsedNode[] = [];
  for (const [nodeId, nodeData] of Object.entries(parsed)) {
    const nd = nodeData as Record<string, unknown>;
    const classType = (nd.class_type as string) || "";
    const meta = nd._meta as { title?: string } | undefined;
    const title = meta?.title || classType;
    const inputs = (nd.inputs || {}) as Record<string, unknown>;

    const stringInputs: { key: string; value: string }[] = [];
    const numericInputs: { key: string; value: number }[] = [];
    for (const [key, val] of Object.entries(inputs)) {
      if (typeof val === "string") {
        stringInputs.push({ key, value: val });
      } else if (typeof val === "number") {
        numericInputs.push({ key, value: val });
      }
    }

    if (stringInputs.length > 0 || numericInputs.length > 0) {
      nodes.push({ nodeId, classType, title, stringInputs, numericInputs });
    }
  }

  return nodes.sort((a, b) => a.title.localeCompare(b.title));
}

export function autoDetectRoles(nodes: ParsedNode[]): RoleAssignment[] {
  const assignments: RoleAssignment[] = [];
  const usedRoles = new Set<string>();

  // CLIPTextEncode with "Positive" in title → positive_prompt
  for (const node of nodes) {
    if (node.classType === "CLIPTextEncode" && /positive/i.test(node.title) && !usedRoles.has("positive_prompt")) {
      const textInput = node.stringInputs.find((i) => i.key === "text");
      if (textInput) {
        assignments.push({
          paramKey: "positive_prompt",
          nodeId: node.nodeId,
          inputKey: "text",
          description: node.title,
        });
        usedRoles.add("positive_prompt");
      }
    }
  }

  // CLIPTextEncode with "Negative" in title → negative_prompt
  for (const node of nodes) {
    if (node.classType === "CLIPTextEncode" && /negative/i.test(node.title) && !usedRoles.has("negative_prompt")) {
      const textInput = node.stringInputs.find((i) => i.key === "text");
      if (textInput) {
        assignments.push({
          paramKey: "negative_prompt",
          nodeId: node.nodeId,
          inputKey: "text",
          description: node.title,
        });
        usedRoles.add("negative_prompt");
      }
    }
  }

  // PrimitiveStringMultiline with "Prompt" in title → positive_prompt (fallback)
  for (const node of nodes) {
    if (
      node.classType === "PrimitiveStringMultiline" &&
      /prompt/i.test(node.title) &&
      !usedRoles.has("positive_prompt")
    ) {
      const valInput = node.stringInputs.find((i) => i.key === "value");
      if (valInput) {
        assignments.push({
          paramKey: "positive_prompt",
          nodeId: node.nodeId,
          inputKey: "value",
          description: node.title,
        });
        usedRoles.add("positive_prompt");
      }
    }
  }

  // LoadImage → input_image
  for (const node of nodes) {
    if (node.classType === "LoadImage" && !usedRoles.has("input_image")) {
      const imgInput = node.stringInputs.find((i) => i.key === "image");
      if (imgInput) {
        assignments.push({ paramKey: "input_image", nodeId: node.nodeId, inputKey: "image", description: node.title });
        usedRoles.add("input_image");
      }
    }
  }

  // Nodes with "num_frames" or "length" numeric input → num_frames
  for (const node of nodes) {
    if (usedRoles.has("num_frames")) break;
    const frameInput = node.numericInputs.find((i) => /^(num_frames|length|frames)$/i.test(i.key));
    if (frameInput) {
      assignments.push({
        paramKey: "num_frames",
        nodeId: node.nodeId,
        inputKey: frameInput.key,
        description: node.title,
      });
      usedRoles.add("num_frames");
    }
  }

  return assignments;
}

export function buildNodeInputOptions(nodes: ParsedNode[]): { value: string; label: string }[] {
  const options: { value: string; label: string }[] = [{ value: "", label: "— none —" }];
  for (const node of nodes) {
    for (const input of node.stringInputs) {
      options.push({
        value: `${node.nodeId}::${input.key}`,
        label: `${node.title} → ${input.key}`,
      });
    }
    for (const input of node.numericInputs) {
      options.push({
        value: `${node.nodeId}::${input.key}`,
        label: `${node.title} → ${input.key} (=${input.value})`,
      });
    }
  }
  return options;
}
