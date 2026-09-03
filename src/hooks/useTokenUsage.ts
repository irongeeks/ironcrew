import { useEffect, useState, useCallback, useMemo } from "react";
import { post, request } from "../api/core";

interface TokenTotals {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

interface ProviderTokenData {
  providers: Array<{
    provider: string;
    model: string;
    total_input: number;
    total_output: number;
    task_count: number;
  }>;
}

export function useProviderTokenUsage() {
  const [data, setData] = useState<ProviderTokenData | null>(null);

  const refresh = useCallback(() => {
    request<ProviderTokenData>("/api/ops/token-usage/by-provider")
      .then(setData)
      .catch(() => setData(null));
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 30_000);
    return () => clearInterval(interval);
  }, [refresh]);

  return data;
}

export function useBulkAgentTokenUsage(agentIds: string[]) {
  const [dataMap, setDataMap] = useState<Map<string, TokenTotals>>(new Map());

  // Stable dependency key: sorted + joined so reorder does not trigger re-fetch
  const stableKey = useMemo(() => [...agentIds].sort().join(","), [agentIds]);

  useEffect(() => {
    if (stableKey === "") return;

    const ids = stableKey.split(",");

    const fetchBulk = () => {
      post<{ usage: Record<string, TokenTotals> }>("/api/ops/token-usage/bulk", { agent_ids: ids })
        .then((data) => {
          const map = new Map<string, TokenTotals>();
          for (const [id, totals] of Object.entries(data.usage)) {
            map.set(id, totals);
          }
          setDataMap(map);
        })
        .catch(() => {
          /* keep previous data on transient failure */
        });
    };

    fetchBulk();
    const interval = setInterval(fetchBulk, 60_000);
    return () => clearInterval(interval);
  }, [stableKey]);

  return dataMap;
}

export type { TokenTotals, ProviderTokenData };
