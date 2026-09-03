import { del, post, request } from "./core";

import type { RemoteFileEntry, RemoteFileStat } from "../types/index";

export async function testSshConnection(serverId: string): Promise<{ success: boolean; error?: string }> {
  return post(`/api/ops/servers/${encodeURIComponent(serverId)}/ssh/test`, {});
}

export async function listRemoteDirectory(
  serverId: string,
  path = "~",
): Promise<{ entries: RemoteFileEntry[]; path: string }> {
  return request(`/api/ops/servers/${encodeURIComponent(serverId)}/fs/list?path=${encodeURIComponent(path)}`);
}

export async function createRemoteDirectory(
  serverId: string,
  path: string,
): Promise<{ success: boolean; path: string }> {
  return post(`/api/ops/servers/${encodeURIComponent(serverId)}/fs/mkdir`, { path });
}

export async function readRemoteFile(
  serverId: string,
  path: string,
): Promise<{ content: string; stat: RemoteFileStat }> {
  return request(`/api/ops/servers/${encodeURIComponent(serverId)}/fs/read?path=${encodeURIComponent(path)}`);
}

export async function deleteRemoteFile(serverId: string, path: string): Promise<{ success: boolean }> {
  return del(`/api/ops/servers/${encodeURIComponent(serverId)}/fs/delete?path=${encodeURIComponent(path)}`);
}
