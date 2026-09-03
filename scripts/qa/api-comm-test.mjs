#!/usr/bin/env node

import {
  BASE_URL,
  LATENCY_SLA_MS,
  createSessionContext,
  nowIso,
  runApiConnectivityTest,
  toPosixRelativePath,
  writeJsonArtifact,
} from "./connectivity-lib.mjs";

export async function main() {
  const context = await createSessionContext();
  const api = await runApiConnectivityTest(context, { attempt: 1 });

  const report = {
    generated_at: nowIso(),
    base_url: BASE_URL,
    acceptance_criteria: {
      http_status: 200,
      endpoint_ok_field: true,
      max_latency_ms: LATENCY_SLA_MS,
      api_success_rule: "One selected enabled provider returns ok=true from /api/api-providers/:id/test within SLA",
    },
    summary: {
      overall_pass: api.pass,
      api,
    },
    evidence: context.evidence,
  };

  const outputPath = writeJsonArtifact(report, { prefix: "api-comm-check" });
  console.log(
    JSON.stringify(
      {
        generated_at: report.generated_at,
        output_path: toPosixRelativePath(outputPath),
        summary: report.summary,
      },
      null,
      2,
    ),
  );

  if (!api.pass) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        generated_at: nowIso(),
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
});
