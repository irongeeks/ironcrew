import path from "node:path";
import { e2ePaths } from "../config/e2e-isolation.ts";

/** Keep browser-test pack writes and registry reloads out of operator packs. */
export function communityPacksDir(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): string {
  if (env.IRONCREW_E2E === "1") {
    return path.join(e2ePaths(env.IRONCREW_E2E_RUN_ID ?? "", cwd).runtimeDir, "community-packs");
  }
  return path.resolve(cwd, "server", "packs", "community");
}
