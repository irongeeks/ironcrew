#!/usr/bin/env node
// Dependency-free source release: only trusted main code, never PR artifacts.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const requiredWorkflows = {
  "rebuild.yml": ["local-contracts (ubuntu-24.04)", "local-contracts (macos-15)", "local-contracts (windows-2025)"],
  "isolation.yml": ["kernel-boundaries"],
  "windows-native.yml": ["native"],
  "ci.yml": ["quality", "unit-web", "unit-api", "unit-scripts", "unit-tests", "e2e", "documentation-screenshots"],
  "platform-production.yml": ["Native (ubuntu-latest)", "Native (macos-latest)", "supply-chain", "docker"],
};

function validateVersion(version) {
  assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, "Stable release version required");
  const [major, minor] = version.split(".").map(Number);
  assert(major > 0 || minor >= 4, "Source release requires version 0.4.0 or newer");
}

export function githubClient(token) {
  assert(token, "GH_TOKEN is required");
  return async (route, { method = "GET", body, binary = false } = {}) => {
    const url = new URL(route, "https://api.github.com");
    assert(["api.github.com", "uploads.github.com"].includes(url.hostname), "Untrusted API host");
    assert.equal(url.protocol, "https:");
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body === undefined
          ? {}
          : {
              "Content-Type": binary ? "application/octet-stream" : "application/json",
            }),
      },
      body: body === undefined ? undefined : binary ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
      redirect: "error",
    });
    if (response.status === 404 && method === "GET") return null;
    if (!response.ok) throw new Error(`GitHub ${method} ${url.pathname}: ${response.status}`);
    return response.status === 204 ? null : response.json();
  };
}

export async function sourceGate({ api, repository, commit, trigger }) {
  assert.match(repository, /^[\w.-]+\/[\w.-]+$/);
  assert.match(commit, /^[a-f0-9]{40}$/);
  const base = `/repos/${repository}`;
  if (
    trigger &&
    (trigger.event !== "push" ||
      trigger.head_branch !== "main" ||
      trigger.head_sha !== commit ||
      trigger.head_repository?.full_name !== repository ||
      trigger.conclusion !== "success")
  ) {
    return {
      ready: false,
      reason: "Trigger is not a successful same-repository main push",
    };
  }
  const main = await api(`${base}/git/ref/heads/main`);
  if (main?.object.sha !== commit) return { ready: false, reason: "Candidate is no longer main HEAD" };
  const file = await api(`${base}/contents/next/package.json?ref=${commit}`);
  const version = JSON.parse(Buffer.from(file.content, "base64").toString("utf8")).version;
  validateVersion(version);
  const tag = `v${version}`;
  const existingTagCommit = await tagCommit(api, base, tag);
  if (existingTagCommit !== null && existingTagCommit !== commit) {
    return { ready: false, reason: `${tag} already belongs to another commit; no new release version requested` };
  }
  const evidence = [];
  for (const [workflow, expectedJobs] of Object.entries(requiredWorkflows)) {
    const result = await api(
      `${base}/actions/workflows/${workflow}/runs?head_sha=${commit}&branch=main&event=push&per_page=100`,
    );
    // Never fall back to an older success after a newer run/attempt fails.
    const run = result?.workflow_runs
      ?.filter(
        (item) =>
          item.head_sha === commit &&
          item.head_branch === "main" &&
          item.event === "push" &&
          item.head_repository?.full_name === repository,
      )
      .sort((a, b) => b.id - a.id)[0];
    if (!run || run.status !== "completed" || run.conclusion !== "success") {
      return {
        ready: false,
        reason: `${workflow} has not succeeded for ${commit}`,
      };
    }
    const jobs = [];
    for (let page = 1; ; page++) {
      const batch = await api(
        `${base}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100&page=${page}`,
      );
      assert(batch?.jobs, "Missing workflow jobs");
      jobs.push(...batch.jobs);
      if (jobs.length >= batch.total_count) break;
      assert(batch.jobs.length, "Incomplete job pagination");
    }
    if (
      expectedJobs.some(
        (name) => !jobs.some((job) => job.name === name && job.status === "completed" && job.conclusion === "success"),
      ) ||
      jobs.some((job) => job.status !== "completed" || job.conclusion !== "success")
    ) {
      return {
        ready: false,
        reason: `${workflow} contains missing, skipped or unsuccessful jobs`,
      };
    }
    evidence.push({
      workflow,
      runId: run.id,
      attempt: run.run_attempt,
      url: run.html_url,
      jobs: jobs.map((job) => job.name),
    });
  }
  return { ready: true, commit, version, tag, evidence };
}

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function packageSource({ cwd, outDir, repository, candidate }) {
  assert(candidate.ready, "All source release gates must pass before packaging");
  assert.match(candidate.commit, /^[a-f0-9]{40}$/);
  validateVersion(candidate.version);
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  assert.equal(git("rev-parse", "HEAD"), candidate.commit, "Checkout must match release commit");
  const committedPackage = JSON.parse(git("show", `${candidate.commit}:next/package.json`));
  assert.equal(committedPackage.version, candidate.version);
  assert.equal(candidate.tag, `v${candidate.version}`, "Tag must match release version");
  const exactVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
  assert.match(committedPackage.engines?.node ?? "", exactVersion, "Exact Node version required in next/package.json");
  const pnpmVersion = /^pnpm@((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(
    committedPackage.packageManager ?? "",
  )?.[1];
  assert(pnpmVersion, "Exact pnpm packageManager required in next/package.json");
  const requirements = { node: committedPackage.engines.node, pnpm: pnpmVersion };
  const notesPath = `docs/releases/v${candidate.version}.md`;
  const notes = execFileSync("git", ["show", `${candidate.commit}:${notesPath}`], { cwd, encoding: "utf8" });
  assert(notes.length > 100, "Release notes must describe the release scope");
  fs.mkdirSync(outDir, { recursive: true });
  const archive = `ironcrew-${candidate.version}-source.tar.gz`;
  git(
    "archive",
    "--format=tar.gz",
    `--prefix=ironcrew-${candidate.version}/`,
    `--output=${path.resolve(outDir, archive)}`,
    candidate.commit,
  );
  const archiveBytes = fs.readFileSync(path.join(outDir, archive));
  const manifest = {
    schemaVersion: 3,
    kind: "source-release",
    repository,
    version: candidate.version,
    tag: candidate.tag,
    commit: candidate.commit,
    applicationDirectory: "next",
    requirements,
    archive: {
      name: archive,
      sha256: hash(archiveBytes),
      bytes: archiveBytes.length,
    },
    notes: { path: notesPath, sha256: hash(Buffer.from(notes)) },
    verification: candidate.evidence,
    distribution: {
      ociImage: false,
      signedNativePackage: false,
      nativeUpdaterCompatible: false,
    },
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const assets = [
    { name: archive, bytes: archiveBytes },
    { name: "release-manifest.json", bytes: manifestBytes },
  ];
  assets.push({
    name: "SHA256SUMS",
    bytes: Buffer.from(assets.map((asset) => `${hash(asset.bytes)}  ${asset.name}\n`).join("")),
  });
  for (const asset of assets) fs.writeFileSync(path.join(outDir, asset.name), asset.bytes);
  const body = `${notes}\n\n## Quellbindung und CI\n\nCommit: \`${candidate.commit}\`.\n\n${candidate.evidence.map((item) => `- [${item.workflow}](${item.url}) (Versuch ${item.attempt})`).join("\n")}\n`;
  return { assets, body, manifest };
}

async function tagCommit(api, base, tag) {
  const ref = await api(`${base}/git/ref/tags/${tag}`);
  if (!ref) return null;
  let object = ref.object;
  for (let depth = 0; object.type === "tag" && depth < 8; depth++) {
    object = (await api(`${base}/git/tags/${object.sha}`)).object;
  }
  assert(object.type === "commit", "Release tag must resolve to a commit");
  return object.sha;
}

async function checkTag(api, base, candidate) {
  const existing = await tagCommit(api, base, candidate.tag);
  assert(existing === null || existing === candidate.commit, "Existing release tag points to a different commit");
}

export async function publishSource({ api, repository, candidate, packaged }) {
  const base = `/repos/${repository}`;
  const recheck = async () => {
    const current = await sourceGate({
      api,
      repository,
      commit: candidate.commit,
    });
    assert(current.ready, current.reason);
    assert.equal(current.version, candidate.version);
    assert.deepEqual(current.evidence, candidate.evidence, "Verification runs changed; regenerate manifest");
    await checkTag(api, base, candidate);
  };
  await recheck();
  let release = await api(`${base}/releases/tags/${candidate.tag}`);
  // The by-tag endpoint is for published releases. List drafts with the workflow
  // token as well so an interrupted upload resumes without creating a duplicate.
  if (!release) {
    for (let page = 1; ; page++) {
      const releases = await api(`${base}/releases?per_page=100&page=${page}`);
      assert(Array.isArray(releases), "Release listing unavailable");
      release = releases.find((item) => item.tag_name === candidate.tag);
      if (release || releases.length < 100) break;
    }
  }
  // Never overwrite a published asset.
  if (release) {
    assert.equal(release.target_commitish, candidate.commit, "Existing release targets another commit");
    assert.equal(release.tag_name, candidate.tag);
  } else {
    release = await api(`${base}/releases`, {
      method: "POST",
      body: {
        tag_name: candidate.tag,
        target_commitish: candidate.commit,
        name: `IronCrew ${candidate.version}`,
        body: packaged.body,
        draft: true,
        prerelease: false,
      },
    });
  }
  const existing = await api(`${base}/releases/${release.id}/assets?per_page=100`);
  assert(existing.length <= packaged.assets.length, "Unexpected release assets");
  for (const asset of existing)
    assert(
      packaged.assets.some((item) => item.name === asset.name),
      "Unexpected release asset",
    );
  for (const asset of packaged.assets) {
    const match = existing.find((item) => item.name === asset.name);
    if (match) {
      assert.equal(match.size, asset.bytes.length, `Asset size mismatch: ${asset.name}`);
      assert.equal(match.digest, `sha256:${hash(asset.bytes)}`, `Asset hash mismatch: ${asset.name}`);
      assert.equal(match.state, "uploaded");
    } else {
      assert(release.draft, "Published release has missing assets; refusing mutation");
      const uploaded = await api(
        `https://uploads.github.com/repos/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(asset.name)}`,
        {
          method: "POST",
          body: asset.bytes,
          binary: true,
        },
      );
      assert.equal(uploaded.digest, `sha256:${hash(asset.bytes)}`, "Uploaded asset hash mismatch");
      assert.equal(uploaded.size, asset.bytes.length);
    }
  }
  if (!release.draft) return release.html_url;
  await recheck();
  const published = await api(`${base}/releases/${release.id}`, {
    method: "PATCH",
    body: { draft: false, body: packaged.body, make_latest: "true" },
  });
  return published.html_url;
}

async function main() {
  const mode = process.argv[2];
  assert(["gate", "publish"].includes(mode), "Usage: source-release.mjs gate|publish");
  const api = githubClient(process.env.GH_TOKEN);
  const repository = process.env.GITHUB_REPOSITORY;
  const commit = process.env.RELEASE_COMMIT;
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  assert.equal(process.env.GITHUB_EVENT_NAME, "workflow_run", "Only trusted main push completions may publish");
  const candidate = await sourceGate({
    api,
    repository,
    commit,
    trigger: event.workflow_run,
  });
  if (mode === "gate") {
    for (const [key, value] of Object.entries({
      ready: candidate.ready,
      commit: candidate.commit ?? "",
    })) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
    }
    process.stdout.write(`${candidate.ready ? `Ready: ${candidate.tag}` : candidate.reason}\n`);
    return;
  }
  assert(candidate.ready, candidate.reason);
  const packaged = packageSource({
    cwd: process.cwd(),
    outDir: path.join(process.env.RUNNER_TEMP, "ironcrew-source-release"),
    repository,
    candidate,
  });
  process.stdout.write(`${await publishSource({ api, repository, candidate, packaged })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
