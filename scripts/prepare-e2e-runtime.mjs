#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { assertE2EPathsSafe, e2ePaths } from "../server/config/e2e-isolation.ts";

// A new directory per invocation avoids deleting another running test's DB.
// Called by start-e2e.ts only after both dedicated ports have been checked.
export function prepareE2ERuntime(runId) {
  assertE2EPathsSafe(runId);
  const paths = e2ePaths(runId);
  fs.mkdirSync(path.dirname(paths.runtimeDir), { recursive: true });
  fs.mkdirSync(paths.runtimeDir); // Refuse reuse, including stale run IDs.
  fs.mkdirSync(paths.logsDir);
  return paths;
}
