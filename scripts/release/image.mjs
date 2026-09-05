#!/usr/bin/env node
import process from "node:process";
import console from "node:console";
// Only this workflow publishes version tags; existing image references are never pushed over.
import fs from "node:fs";
import { ghcrRegistryToken } from "../lib/release-github.mjs";
import { execFileSync } from "node:child_process";
import { validateVersion, SHA, DIGEST, ensureVersionImage } from "../lib/release-packaging.mjs";
const version = validateVersion(process.env.RELEASE_VERSION);
const commit = process.env.RELEASE_COMMIT;
const repository = process.env.GITHUB_REPOSITORY?.toLowerCase();
if (!SHA.test(commit) || !repository || !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repository))
  throw new Error("Invalid image release identity.");
const image = `ghcr.io/${repository}:v${version}`;
const run = (args) => execFileSync("docker", args, { stdio: "inherit" });
async function remoteDigest(authenticated = true) {
  const token = await ghcrRegistryToken({
    repository,
    authenticated,
    actor: process.env.GITHUB_ACTOR,
    token: process.env.GH_TOKEN,
  });
  const response = await globalThis.fetch(`https://ghcr.io/v2/${repository}/manifests/v${version}`, {
    method: "HEAD",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept:
        "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.index.v1+json",
    },
    signal: globalThis.AbortSignal.timeout(30000),
    redirect: "error",
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GHCR manifest request failed (${response.status}).`);
  const digest = response.headers.get("docker-content-digest");
  if (!DIGEST.test(digest)) throw new Error("GHCR manifest digest missing.");
  return digest;
}
const digest = await ensureVersionImage({
  getDigest: remoteDigest,
  run,
  inspect: (pinned) =>
    JSON.parse(
      execFileSync("docker", ["image", "inspect", pinned, "--format", "{{json .Config.Labels}}"], { encoding: "utf8" }),
    ),
  smoke: (pinned) => execFileSync(process.execPath, ["scripts/ci/docker-smoke.mjs", pinned], { stdio: "inherit" }),
  image,
  version,
  commit,
  repository,
});
try {
  if ((await remoteDigest(false)) !== digest) throw new Error("Anonymous digest differs.");
  console.log("GHCR image is anonymously readable.");
} catch {
  console.log(
    "::warning::Anonymous GHCR access was not verified. Docker login may be required; package visibility was not changed.",
  );
}
fs.appendFileSync(process.env.GITHUB_OUTPUT, `digest=${digest}\nimage=${image}\n`);
console.log(`Verified release image: ${image}@${digest}`);
