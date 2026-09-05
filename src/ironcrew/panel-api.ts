import { request } from "../api/core";

/** JSON panel mutations use the same session/CSRF transport as the main Crew client. */
export function requestJson<T>(url: string, options?: RequestInit): Promise<T> {
  if (!options) return request<T>(url);
  if (!options.body) return request<T>(url, options);
  const headers = new Headers(options.headers);
  headers.set("Content-Type", "application/json");
  return request<T>(url, { ...options, headers });
}
