import { z } from "zod";

export const BUSINESS_SOURCE_IDS = ["proxmox", "rmm-agents", "rmm-alerts", "unifi", "sevdesk", "lexware"] as const;
export const businessRefreshSchema = z.object({ agentId: z.string().trim().min(1).max(150) }).strict();
export interface BusinessMetric {
  key: string;
  label: string;
  value: number;
  unit: "count";
}
export interface BusinessRecord {
  id: string;
  label: string;
  status: string;
}
export interface BusinessSource {
  id: (typeof BUSINESS_SOURCE_IDS)[number];
  label: string;
  packKey: string;
  integration: string;
  toolKey: string;
  state: "not_installed" | "not_configured" | "not_refreshed" | "ok" | "denied" | "approval_required" | "error";
  fetchedAt: number | null;
  attemptedAt: number | null;
  message: string;
  endpoint: string;
  metrics: BusinessMetric[];
  records: BusinessRecord[];
  limited: boolean;
  approvalId?: string;
}
export interface BusinessDashboardSnapshot {
  sources: BusinessSource[];
  agents: { id: string; displayName: string }[];
}
