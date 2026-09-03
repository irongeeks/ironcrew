import { z } from "zod/v4";

export const SshExecSchema = z.object({
  command: z.string().min(1, "command is required"),
});

export const SshUploadSchema = z.object({
  remote_path: z.string().min(1, "remote_path is required"),
  content_base64: z.string().min(1, "content_base64 is required"),
});

export const SshMkdirSchema = z.object({
  path: z.string().min(1, "path is required"),
});

export const SshWriteSchema = z.object({
  path: z.string().min(1, "path is required"),
  content: z.string(),
});

export const DocsProviderCreateSchema = z.object({
  name: z.string().max(200).optional(),
  vaultPath: z.string().min(1, "vault_path_required"),
  enabled: z.boolean().optional(),
  readOnly: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
});

export const DocsProviderUpdateSchema = z.object({
  name: z.string().max(200).optional(),
  vaultPath: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  readOnly: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
});

export const DocsBindingCreateSchema = z.object({
  projectId: z.string().nullable().optional(),
  projectPathPrefix: z.string().nullable().optional(),
});

export const DocsNoteWriteSchema = z.object({
  path: z.string().min(1, "path_required"),
  content: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export const DocsNoteCreateSchema = z.object({
  title: z.string().min(1, "title_required"),
  folder: z.string().optional(),
  content: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export const DocsSearchSchema = z.object({
  query: z.string().min(1, "query_required"),
  limit: z.number().int().positive().optional(),
  tags: z.array(z.string()).optional(),
});

export const DocsWikilinkFormatSchema = z.object({
  target: z.string().min(1, "target_required"),
  alias: z.string().optional(),
  content: z.string().optional(),
});
