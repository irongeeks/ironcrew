#!/usr/bin/env node
import process from "node:process";
import console from "node:console";
import fs from "node:fs";
import { githubClient, releaseGate } from "../lib/release-github.mjs";
const payload = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
const result = await releaseGate({
  api: githubClient({ token: process.env.GH_TOKEN }),
  repository: process.env.GITHUB_REPOSITORY,
  commit: process.env.RELEASE_COMMIT,
  event: process.env.GITHUB_EVENT_NAME,
  trigger: payload.workflow_run,
});
for (const [key, value] of Object.entries(result))
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value ?? ""}\n`);
console.log(result.ready ? `Release candidate ${result.tag}: ${result.commit}` : result.reason);
