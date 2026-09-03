// ---- Level helpers ----

export const LEVEL_LABELS: Record<number, string> = {
  10: "TRACE",
  20: "DEBUG",
  30: "INFO",
  40: "WARN",
  50: "ERROR",
  60: "FATAL",
};
export const LEVEL_COLORS: Record<number, string> = {
  10: "#9ca3af",
  20: "#9ca3af",
  30: "#60a5fa",
  40: "#fbbf24",
  50: "#ef4444",
  60: "#dc2626",
};

// ---- Time ranges ----

export const TIME_RANGES = [
  { label: "1h", ms: 3_600_000 },
  { label: "6h", ms: 21_600_000 },
  { label: "24h", ms: 86_400_000 },
  { label: "7d", ms: 604_800_000 },
] as const;
