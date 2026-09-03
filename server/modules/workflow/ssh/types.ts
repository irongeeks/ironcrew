import { z } from "zod/v4";

export const SshConfigSchema = z.object({
  host: z.string().min(1),
  port: z.number().default(22),
  user: z.string().min(1),
  private_key_path: z.string().min(1),
  known_hosts_policy: z.enum(["accept", "strict"]).default("accept"),
  allowed_commands: z.array(z.string()).optional(),
});

export type SshConfig = z.infer<typeof SshConfigSchema>;

export const FileEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(["file", "directory", "symlink"]),
  size: z.number(),
  modified: z.string(),
  permissions: z.string(),
});

export type FileEntry = z.infer<typeof FileEntrySchema>;

const FileStatSchema = z.object({
  type: z.enum(["file", "directory", "symlink"]),
  size: z.number(),
  modified: z.string(),
  permissions: z.string(),
  owner: z.string(),
  group: z.string(),
});

export type FileStat = z.infer<typeof FileStatSchema>;

export interface SshExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
