import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { packageSource, publishSource, requiredWorkflows, sourceGate } from "./source-release.mjs";

const repository = "irongeeks/ironcrew";
const commit = "a".repeat(40);
const base = `/repos/${repository}`;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

function fixture() {
  const runs = Object.entries(requiredWorkflows).map(([workflow, names], index) => ({
    workflow,
    run: {
      id: index + 1,
      run_attempt: 1,
      head_sha: commit,
      head_branch: "main",
      event: "push",
      head_repository: { full_name: repository },
      status: "completed",
      conclusion: "success",
      html_url: `https://github.com/${repository}/actions/runs/${index + 1}`,
    },
    jobs: names.map((name) => ({
      name,
      status: "completed",
      conclusion: "success",
    })),
  }));
  const state = {
    runs,
    main: commit,
    version: "0.4.1",
    release: null,
    tag: null,
    assets: [],
    writes: [],
  };
  const api = async (route, options = {}) => {
    if (options.method) {
      state.writes.push({ route, ...options });
      if (route === `${base}/releases`) {
        state.release = {
          id: 99,
          ...options.body,
          html_url: "https://github.com/irongeeks/ironcrew/releases/tag/v0.4.1",
        };
        return state.release;
      }
      if (route.includes("uploads.github.com")) {
        const asset = {
          name: new URL(route).searchParams.get("name"),
          size: options.body.length,
          digest: `sha256:${sha(options.body)}`,
          state: "uploaded",
        };
        state.assets.push(asset);
        return asset;
      }
      if (route === `${base}/releases/99`) return Object.assign(state.release, options.body);
      assert.fail(`Unexpected write: ${route}`);
    }
    if (route === `${base}/git/ref/heads/main`) return { object: { sha: state.main } };
    if (route.startsWith(`${base}/contents/next/package.json`))
      return {
        content: Buffer.from(JSON.stringify({ version: state.version })).toString("base64"),
      };
    if (route.startsWith(`${base}/git/ref/tags/`)) return state.tag;
    if (route.startsWith(`${base}/releases/tags/`)) return state.release?.draft ? null : state.release;
    if (route.startsWith(`${base}/releases?`)) return state.release ? [state.release] : [];
    if (route === `${base}/releases/99/assets?per_page=100`) return state.assets;
    for (const item of runs) {
      if (route.startsWith(`${base}/actions/workflows/${item.workflow}/runs?`))
        return {
          workflow_runs: item.extraRuns ? [...item.extraRuns, item.run] : [item.run],
        };
      if (route.startsWith(`${base}/actions/runs/${item.run.id}/attempts/${item.run.run_attempt}/jobs?`))
        return { total_count: item.jobs.length, jobs: item.jobs };
    }
    assert.fail(`Unexpected read: ${route}`);
  };
  return { api, state };
}

test("requires all five workflows and all named OS jobs at the exact main SHA", async () => {
  const { api } = fixture();
  const candidate = await sourceGate({ api, repository, commit });
  assert.equal(candidate.ready, true);
  assert.equal(candidate.evidence.length, 5);
  assert.equal(candidate.tag, "v0.4.1");
});

test("rejects forks, pull requests, stale main and wrong candidate SHA", async () => {
  for (const change of [
    { event: "pull_request" },
    { head_branch: "other" },
    { head_sha: "b".repeat(40) },
    { head_repository: { full_name: "fork/ironcrew" } },
    { conclusion: "failure" },
  ]) {
    const { api, state } = fixture();
    const trigger = { ...state.runs[0].run, ...change };
    assert.equal((await sourceGate({ api, repository, commit, trigger })).ready, false);
  }
  const { api, state } = fixture();
  state.main = "b".repeat(40);
  assert.equal((await sourceGate({ api, repository, commit })).ready, false);
  await assert.rejects(sourceGate({ api, repository, commit: "main" }));
});

test("missing, skipped, failed and pending jobs cannot become successful release evidence", async () => {
  for (const conclusion of ["skipped", "failure", "cancelled", null]) {
    const { api, state } = fixture();
    state.runs[0].jobs[1].conclusion = conclusion;
    assert.equal((await sourceGate({ api, repository, commit })).ready, false);
  }
  const { api, state } = fixture();
  state.runs[0].jobs.pop();
  assert.equal((await sourceGate({ api, repository, commit })).ready, false);
});

test("a newer failed run blocks an older success and a different SHA cannot satisfy a workflow", async () => {
  const { api, state } = fixture();
  state.runs[0].extraRuns = [{ ...state.runs[0].run, id: 999, conclusion: "failure" }];
  assert.equal((await sourceGate({ api, repository, commit })).ready, false);
  delete state.runs[0].extraRuns;
  state.runs[0].run.head_sha = "b".repeat(40);
  assert.equal((await sourceGate({ api, repository, commit })).ready, false);
});

test("legacy and prerelease versions cannot trigger the source publisher", async () => {
  for (const version of ["0.3.1", "0.4.1-test", "v0.4.1", "0.4.1\nready=true"]) {
    const { api, state } = fixture();
    state.version = version;
    await assert.rejects(sourceGate({ api, repository, commit }));
  }
});

test("publishes a draft only after every asset hash and a fresh gate pass; repeat is read-only", async () => {
  const { api, state } = fixture();
  const candidate = await sourceGate({ api, repository, commit });
  const packaged = {
    body: "Source release",
    assets: [
      { name: "archive.tar.gz", bytes: Buffer.from("archive") },
      { name: "SHA256SUMS", bytes: Buffer.from("checksums") },
    ],
  };
  await publishSource({ api, repository, candidate, packaged });
  assert.equal(state.release.draft, false);
  assert.equal(state.writes.at(-1).method, "PATCH");
  const count = state.writes.length;
  await publishSource({ api, repository, candidate, packaged });
  assert.equal(state.writes.length, count);
});

test("resumes matching draft assets without replacement and refuses mismatches", async () => {
  for (const matches of [true, false]) {
    const { api, state } = fixture();
    const candidate = await sourceGate({ api, repository, commit });
    const bytes = Buffer.from("archive");
    state.release = {
      id: 99,
      target_commitish: commit,
      tag_name: "v0.4.1",
      draft: true,
    };
    state.assets.push({
      name: "source.tar.gz",
      size: bytes.length,
      digest: `sha256:${sha(matches ? bytes : Buffer.from("changed"))}`,
      state: "uploaded",
    });
    const request = publishSource({
      api,
      repository,
      candidate,
      packaged: { body: "notes", assets: [{ name: "source.tar.gz", bytes }] },
    });
    if (matches) {
      await request;
      assert.equal(state.writes.length, 1);
      assert.equal(state.writes[0].method, "PATCH");
    } else {
      await assert.rejects(request, /hash mismatch/);
      assert.equal(state.writes.length, 0);
    }
  }
});

test("leaves the release as a draft if main changes during upload", async () => {
  const { api, state } = fixture();
  const candidate = await sourceGate({ api, repository, commit });
  const changingApi = async (route, options) => {
    const result = await api(route, options);
    if (route.includes("uploads.github.com")) state.main = "b".repeat(40);
    return result;
  };
  await assert.rejects(
    publishSource({
      api: changingApi,
      repository,
      candidate,
      packaged: { body: "notes", assets: [{ name: "source.tar.gz", bytes: Buffer.from("archive") }] },
    }),
    /no longer main HEAD/,
  );
  assert.equal(state.release.draft, true);
  assert.equal(state.writes.filter((write) => write.method === "PATCH").length, 0);
});

test("refuses a moved tag, newly failing gate, and incomplete already-published release", async () => {
  for (const condition of ["tag", "gate", "published"]) {
    const { api, state } = fixture();
    const candidate = await sourceGate({ api, repository, commit });
    if (condition === "tag") state.tag = { object: { type: "commit", sha: "b".repeat(40) } };
    if (condition === "gate") state.runs[1].run.conclusion = "failure";
    if (condition === "published")
      state.release = {
        id: 99,
        tag_name: "v0.4.1",
        target_commitish: commit,
        draft: false,
      };
    await assert.rejects(
      publishSource({
        api,
        repository,
        candidate,
        packaged: {
          body: "notes",
          assets: [{ name: "source.tar.gz", bytes: Buffer.from("archive") }],
        },
      }),
    );
    assert.equal(state.writes.length, 0);
  }
});

test("archives the committed full repository reproducibly, hashes notes and excludes local files", async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ironcrew-source-release-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const cwd = path.join(temp, "repo");
  fs.mkdirSync(path.join(cwd, "next"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "docs/releases"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "next/package.json"), JSON.stringify({ version: "0.4.1" }));
  fs.writeFileSync(path.join(cwd, "legacy.txt"), "legacy source\n");
  const notes =
    "Source release with full repository and next application; no signed native package or OCI image is published.\n\n";
  fs.writeFileSync(path.join(cwd, "docs/releases/v0.4.1.md"), notes);
  const git = (...args) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init");
  git("add", ".");
  git("-c", "user.name=Source Release Test", "-c", "user.email=source-test@example.invalid", "commit", "-m", "fixture");
  const candidate = {
    ready: true,
    commit: git("rev-parse", "HEAD"),
    version: "0.4.1",
    tag: "v0.4.1",
    evidence: [],
  };
  fs.writeFileSync(path.join(cwd, "secret.txt"), "untracked secret");
  fs.writeFileSync(path.join(cwd, "legacy.txt"), "dirty source");
  const packaged = packageSource({
    cwd,
    outDir: path.join(temp, "a"),
    repository,
    candidate,
  });
  const repeated = packageSource({
    cwd,
    outDir: path.join(temp, "b"),
    repository,
    candidate,
  });
  assert.deepEqual(packaged.assets, repeated.assets);
  assert.equal(packaged.manifest.notes.sha256, sha(Buffer.from(notes)));
  assert.equal(packaged.manifest.distribution.nativeUpdaterCompatible, false);
  const archive = path.join(temp, "a", packaged.assets[0].name);
  const contents = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" });
  assert.match(contents, /ironcrew-0.4.1\/next\/package.json/);
  assert.doesNotMatch(contents, /secret.txt/);
  assert.equal(
    execFileSync("tar", ["-xOzf", archive, "ironcrew-0.4.1/legacy.txt"], {
      encoding: "utf8",
    }),
    "legacy source\n",
  );
  assert.equal(packaged.manifest.archive.sha256, sha(packaged.assets[0].bytes));
  for (const asset of packaged.assets.slice(0, 2))
    assert(packaged.assets[2].bytes.toString().includes(`${sha(asset.bytes)}  ${asset.name}\n`));
  assert.throws(
    () =>
      packageSource({
        cwd,
        outDir: path.join(temp, "c"),
        repository,
        candidate: { ...candidate, commit: "b".repeat(40) },
      }),
    /Checkout must match/,
  );
});
