#!/usr/bin/env node

import {
  BASE_URL,
  LATENCY_SLA_MS,
  createSessionContext,
  nowIso,
  runOAuthConnectivityTest,
  toPosixRelativePath,
  writeJsonArtifact,
} from "./connectivity-lib.mjs";

export async function main() {
  const context = await createSessionContext();
  const oauth = await runOAuthConnectivityTest(context, { attempt: 1 });

  const report = {
    generated_at: nowIso(),
    base_url: BASE_URL,
    acceptance_criteria: {
      http_status: 200,
      max_latency_ms: LATENCY_SLA_MS,
      oauth_success_rule: "OAuth refresh roundtrip (preferred) or model fetch fallback succeeds within SLA",
    },
    summary: {
      overall_pass: oauth.pass,
      oauth,
    },
    evidence: context.evidence,
  };

  const outputPath = writeJsonArtifact(report, { prefix: "oauth-comm-check" });
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

  if (!oauth.pass) {
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
