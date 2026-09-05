#!/usr/bin/env node
import process from "node:process";
import console from "node:console";
import { parseDockerUpdateArgs, updateDockerRelease } from "./lib/docker-update.mjs";

const help = `IronCrew Docker release update (run from the existing Compose directory)

  node scripts/ironcrew-docker-update.mjs --to vX.Y.Z --backup-dir /private/backups --check
  node scripts/ironcrew-docker-update.mjs --to vX.Y.Z --backup-dir /private/backups

  --to <version>              Explicit stable release; no latest tag or downgrade
  --backup-dir <absolute>      Owned directory, mode 0700, outside application mounts
  --check / --dry-run          Read-only preflight; no pull, stop, backup or config write
  --manifest <file>            Previously downloaded official release-manifest.json
  --expected-version <version> Required when --to is a full published GHCR digest
  --help                      Show this help

The updater uses compose.yaml + compose.release.yaml, profile prod, and preserves
existing project/volume identities. It downloads the published manifest, verifies
image digest + OCI version/revision, backs up stopped data, and verifies health.
Failures after stop remain stopped. Recovery is manual from the private record;
old code is never automatically started against potentially migrated data.
`;
const controller = new globalThis.AbortController();
const interrupt = () => controller.abort();
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
try {
  const options = parseDockerUpdateArgs(process.argv.slice(2));
  if (options.help) console.log(help);
  else console.log(JSON.stringify(await updateDockerRelease(options, { signal: controller.signal }), null, 2));
} catch (error) {
  console.error(`[ironcrew-docker-update] ${error instanceof Error ? error.message : "Update failed"}`);
  process.exitCode = 1;
} finally {
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
}
