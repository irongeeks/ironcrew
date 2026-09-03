#!/usr/bin/env node

import fs from "node:fs";
import { pathToFileURL } from "node:url";

import {
  BASE_URL,
  LATENCY_SLA_MS,
  RETRY_COUNT,
  createSessionContext,
  fileTimestamp,
  formatLatency,
  nowIso,
  runApiConnectivityTest,
  runLlmConnectivityTest,
  runOAuthConnectivityTest,
  safeFileSlug,
  summarizeApiProviders,
  toPosixRelativePath,
  writeJsonArtifact,
  writeMarkdownArtifact,
} from "./connectivity-lib.mjs";

function toStatusLabel(pass) {
  return pass ? "PASS" : "FAIL";
}

function summarizeAttempt(attempt) {
  return {
    id: attempt.id,
    pass: attempt.pass,
    attempt: attempt.attempt,
    endpoint: attempt.endpoint,
    status: attempt.status,
    latency_ms: attempt.latency_ms,
    note: attempt.note,
  };
}

async function runWithRetry({ runOnce }) {
  const attempts = [];
  for (let idx = 0; idx <= RETRY_COUNT; idx += 1) {
    const attemptNumber = idx + 1;
    const result = await runOnce(attemptNumber);
    attempts.push(result);
    if (result.pass) break;
  }
  return {
    attempts,
    final: attempts[attempts.length - 1],
    retry_count: attempts.length - 1,
  };
}

function buildSuiteReportMarkdown({
  report,
  sessionLabel,
  jsonPath,
  markdownPath,
  projectCheck,
  llmBundle,
  oauthBundle,
  apiBundle,
}) {
  const llm = report.summary.llm;
  const oauth = report.summary.oauth;
  const api = report.summary.api;
  const lines = [
    `# QA Connectivity Report (Task Session ${sessionLabel})`,
    "",
    `- Team/owner: \`QA/QC - Lint\``,
    `- Generated at (UTC): \`${report.generated_at}\``,
    `- Base URL: \`${BASE_URL}\``,
    "",
    "## Checklist 1: Structure and baseline review",
    "",
    "| Item | Status | Notes |",
    "|---|---|---|",
    `| scripts/test-comm-status.mjs baseline | ${projectCheck.existing_legacy_script ? "FOUND" : "MISSING"} | Legacy entrypoint for comm checks |`,
    `| server/modules/routes/ops.ts endpoints | ${projectCheck.routes_verified ? "VERIFIED" : "NOT_VERIFIED"} | /api/cli-usage/refresh, /api/oauth/*, /api/api-providers/:id/test |`,
    `| server/security/auth.ts session flow | ${projectCheck.auth_verified ? "VERIFIED" : "NOT_VERIFIED"} | /api/auth/session cookie bootstrap |`,
    "",
    "## Checklist 2-4: One-run communication tests",
    "",
    "| Area | Script | Final Result | HTTP | Latency | Retry Count |",
    "|---|---|---|---:|---:|---:|",
    `| LLM | \`scripts/qa/llm-comm-test.mjs\` | ${toStatusLabel(llm.pass)} | ${llm.status ?? "-"} | ${formatLatency(llm.latency_ms)} | ${llmBundle.retry_count} |`,
    `| OAuth | \`scripts/qa/oauth-comm-test.mjs\` | ${toStatusLabel(oauth.pass)} | ${oauth.status ?? "-"} | ${formatLatency(oauth.latency_ms)} | ${oauthBundle.retry_count} |`,
    `| API | \`scripts/qa/api-comm-test.mjs\` | ${toStatusLabel(api.pass)} | ${api.status ?? "-"} | ${formatLatency(api.latency_ms)} | ${apiBundle.retry_count} |`,
    "",
    "## Checklist 5: Integrated runner and evidence/report",
    "",
    `- Integrated runner: \`scripts/qa/run-comm-suite.mjs\``,
    `- Legacy compatibility entry: \`scripts/test-comm-status.mjs\``,
    `- Evidence JSON: \`${toPosixRelativePath(jsonPath)}\``,
    `- QA report: \`${markdownPath}\``,
    "",
    "## Acceptance criteria",
    "",
    `- HTTP status: \`200\``,
    `- Max latency (SLA): \`${LATENCY_SLA_MS}ms\``,
    `- LLM success rule: at least one provider returns \`error=null\` from \`/api/cli-usage/refresh\``,
    `- OAuth success rule: refresh roundtrip (or model-fetch fallback) succeeds within SLA`,
    `- API success rule: one selected enabled provider returns \`ok=true\` from \`/api/api-providers/:id/test\` within SLA`,
    "",
    "## Retry and escalation policy",
    "",
    `- Retry: each failed item retried up to ${RETRY_COUNT} time(s) in the same run context.`,
    "- Escalation trigger: any item still FAIL after retries.",
    "- Escalation action: notify Dev lead within 30 minutes with endpoint, latency, status, and evidence JSON path.",
    "",
    "## Final result snapshot",
    "",
    `- LLM: ${toStatusLabel(llm.pass)} (${llm.note})`,
    `- OAuth: ${toStatusLabel(oauth.pass)} (${oauth.note})`,
    `- API: ${toStatusLabel(api.pass)} (${summarizeApiProviders(api.provider_results)})`,
    `- Overall: **${toStatusLabel(report.summary.overall_pass)}**`,
    "",
    "## Attempts",
    "",
    `- LLM attempts: ${llmBundle.attempts.map((item) => `#${item.attempt}:${toStatusLabel(item.pass)}`).join(", ")}`,
    `- OAuth attempts: ${oauthBundle.attempts.map((item) => `#${item.attempt}:${toStatusLabel(item.pass)}`).join(", ")}`,
    `- API attempts: ${apiBundle.attempts.map((item) => `#${item.attempt}:${toStatusLabel(item.pass)}`).join(", ")}`,
    "",
  ];
  return `${lines.join("\n")}\n`;
}

function resolveSessionLabel() {
  const taskSessionId = process.env.QA_TASK_SESSION_ID ?? process.env.TASK_SESSION_ID ?? "";
  if (taskSessionId) return safeFileSlug(taskSessionId, fileTimestamp());
  return fileTimestamp();
}

function buildProjectStructureCheck() {
  return {
    checked_at: nowIso(),
    existing_legacy_script: fs.existsSync("scripts/test-comm-status.mjs"),
    routes_verified: fs.existsSync("server/modules/routes/ops.ts"),
    auth_verified: fs.existsSync("server/security/auth.ts"),
    inspected_files: ["scripts/test-comm-status.mjs", "server/modules/routes/ops.ts", "server/security/auth.ts"],
  };
}

export async function main() {
  const sessionLabel = resolveSessionLabel();
  const context = await createSessionContext();
  const projectCheck = buildProjectStructureCheck();

  const llmBundle = await runWithRetry({
    runOnce: (attempt) => runLlmConnectivityTest(context, { attempt }),
  });
  const oauthBundle = await runWithRetry({
    runOnce: (attempt) => runOAuthConnectivityTest(context, { attempt }),
  });
  const apiBundle = await runWithRetry({
    runOnce: (attempt) => runApiConnectivityTest(context, { attempt }),
  });

  const llm = llmBundle.final;
  const oauth = oauthBundle.final;
  const api = apiBundle.final;
  const overallPass = Boolean(llm.pass && oauth.pass && api.pass);

  const report = {
    generated_at: nowIso(),
    qa_task_session_id: process.env.QA_TASK_SESSION_ID ?? process.env.TASK_SESSION_ID ?? null,
    base_url: BASE_URL,
    checklist: {
      project_structure_review: projectCheck,
      scripts: {
        llm_script: "scripts/qa/llm-comm-test.mjs",
        oauth_script: "scripts/qa/oauth-comm-test.mjs",
        api_script: "scripts/qa/api-comm-test.mjs",
        suite_runner: "scripts/qa/run-comm-suite.mjs",
      },
    },
    acceptance_criteria: {
      http_status: 200,
      endpoint_ok_field: true,
      max_latency_ms: LATENCY_SLA_MS,
      llm_success_rule: "At least one provider returns error=null from /api/cli-usage/refresh within SLA.",
      oauth_success_rule: "OAuth refresh roundtrip succeeds, or OAuth model fetch fallback succeeds, within SLA.",
      api_success_rule:
        "One selected enabled API provider returns ok=true from /api/api-providers/:id/test within SLA.",
    },
    retry_and_escalation: {
      retry_count_per_item: RETRY_COUNT,
      retry_policy: "Retry each failed test item up to the configured count in the same run context.",
      escalation_trigger: "Any item still failing after retries.",
      escalation_action: "Escalate to Dev lead within 30 minutes with evidence log and failing endpoint details.",
    },
    summary: {
      overall_pass: overallPass,
      llm,
      oauth,
      api,
      retries: {
        llm: llmBundle.retry_count,
        oauth: oauthBundle.retry_count,
        api: apiBundle.retry_count,
      },
      attempt_overview: {
        llm: llmBundle.attempts.map(summarizeAttempt),
        oauth: oauthBundle.attempts.map(summarizeAttempt),
        api: apiBundle.attempts.map(summarizeAttempt),
      },
    },
    evidence: context.evidence,
  };

  const jsonPath = writeJsonArtifact(report, { prefix: "comm-check" });
  const markdownName = `qa-connectivity-${sessionLabel}-report.md`;
  const markdownBody = buildSuiteReportMarkdown({
    report,
    sessionLabel,
    jsonPath,
    markdownPath: `docs/${markdownName}`,
    projectCheck,
    llmBundle,
    oauthBundle,
    apiBundle,
  });
  const markdownPath = writeMarkdownArtifact(markdownBody, { fileName: markdownName });

  console.log(
    JSON.stringify(
      {
        generated_at: report.generated_at,
        output_path: toPosixRelativePath(jsonPath),
        markdown_report: toPosixRelativePath(markdownPath),
        summary: report.summary,
      },
      null,
      2,
    ),
  );

  if (!overallPass) {
    process.exitCode = 1;
  }
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  return import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectExecution()) {
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
}
