#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inventory, licenseFindings, cyclonedx } from "./lib/supply-chain.mjs";
const [report, outDir] = process.argv.slice(2);
if (!report || !outDir)
  throw new Error("Usage: node scripts/supply-chain-report.mjs pnpm-licenses.json output-directory");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const components = inventory(JSON.parse(fs.readFileSync(report, "utf8")));
const baseline = JSON.parse(fs.readFileSync(path.join(root, "deploy/license-baseline.json"), "utf8"));
const app = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "sbom.cdx.json"), JSON.stringify(cyclonedx(components, app), null, 2) + "\n");
fs.writeFileSync(path.join(outDir, "licenses.json"), JSON.stringify(components, null, 2) + "\n");
const findings = licenseFindings(components, baseline.components);
fs.writeFileSync(
  path.join(outDir, "license-review.json"),
  JSON.stringify({ inheritedReviewRequired: baseline.components, newFindings: findings }, null, 2) + "\n",
);
if (findings.length) {
  console.error("New or changed nonstandard/unknown licenses require explicit review:", findings);
  process.exitCode = 1;
} else
  console.log(
    `${components.length} production components inventoried. Known inherited custom licenses remain visible in license-review.json.`,
  );
