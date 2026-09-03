import { request } from "./core";

export interface BrowseEntry {
  name: string;
  type: "file" | "directory";
  size: number;
  gitStatus: "modified" | "added" | "deleted" | "renamed" | "untracked" | "has_changes" | null;
}

export interface BrowseDirResult {
  ok: boolean;
  basePath: string;
  branchName: string | null;
  relativePath: string;
  entries: BrowseEntry[];
  error?: string;
}

export interface BrowseFileResult {
  ok: boolean;
  relativePath: string;
  type: "text" | "markdown" | "image" | "video" | "audio" | "pdf" | "binary";
  language: string | null;
  mimeType: string;
  size: number;
  gitStatus: string | null;
  content?: string | null;
  streamUrl?: string | null;
  error?: string;
}

export async function browseTaskDirectory(taskId: string, relativePath = "/"): Promise<BrowseDirResult> {
  return request<BrowseDirResult>(`/api/tasks/${taskId}/browse?path=${encodeURIComponent(relativePath)}`);
}

export async function browseProjectDirectory(projectPath: string, relativePath = "/"): Promise<BrowseDirResult> {
  return request<BrowseDirResult>(
    `/api/browse?projectPath=${encodeURIComponent(projectPath)}&path=${encodeURIComponent(relativePath)}`,
  );
}

export async function browseTaskFile(taskId: string, relativePath: string): Promise<BrowseFileResult> {
  return request<BrowseFileResult>(`/api/tasks/${taskId}/browse?path=${encodeURIComponent(relativePath)}&content=true`);
}

export async function browseProjectFile(projectPath: string, relativePath: string): Promise<BrowseFileResult> {
  return request<BrowseFileResult>(
    `/api/browse?projectPath=${encodeURIComponent(projectPath)}&path=${encodeURIComponent(relativePath)}&content=true`,
  );
}
