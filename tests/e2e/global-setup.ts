import { request } from "@playwright/test";
import { E2E_BASE_URL, e2ePaths, e2eReadyPath } from "../../server/config/e2e-isolation.ts";

/** Fail before any fixture can mutate settings, even if a wrong server returns 200. */
export default async function verifyIsolatedApi() {
  const runId = process.env.IRONCREW_E2E_RUN_ID ?? "";
  const expected = e2ePaths(runId);
  const client = await request.newContext({ baseURL: E2E_BASE_URL });
  try {
    const response = await client.get(e2eReadyPath(runId), { maxRedirects: 0 });
    if (!response.ok()) throw new Error("Isolated E2E API is unavailable");
    const identity = await response.json();
    if (identity.runId !== runId || identity.dbPath !== expected.dbPath) {
      throw new Error("E2E API identity mismatch: refusing all test writes");
    }
  } finally {
    await client.dispose();
  }
}
