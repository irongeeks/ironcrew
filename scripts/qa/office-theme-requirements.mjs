#!/usr/bin/env node

import { runOfficeThemeRequirements } from "./office-theme-requirements-lib/run.mjs";

runOfficeThemeRequirements().catch((error) => {
  process.stderr.write(`[office-theme-requirements] ${error?.stack ?? String(error)}\n`);
  process.exitCode = 1;
});
