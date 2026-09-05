import { Buffer } from "node:buffer";
import { URL } from "node:url";
import { afterEach, describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import yaml from "js-yaml";
import { createReleasePackage, sha256, ensureVersionImage } from "./release-packaging.mjs";
import { releaseGate, publishRelease, githubClient, ghcrRegistryToken } from "./release-github.mjs";
const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function repository() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ironcrew-release-test-"));
  dirs.push(dir);
  const git = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git(["init", "-q"]);
  git(["config", "user.email", "release@example.invalid"]);
  git(["config", "user.name", "Release Test"]);
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: "2.8.0" }));
  fs.writeFileSync(path.join(dir, "README.md"), "Source");
  git(["add", "."]);
  git(["commit", "-qm", "fixture"]);
  return { dir, git, commit: git(["rev-parse", "HEAD"]) };
}
const commit = "a".repeat(40),
  digest = `sha256:${"b".repeat(64)}`,
  repo = "irongeeks/ironcrew";
function gateApi({
  ci = "success",
  platform = "success",
  release = null,
  ref = null,
  main = commit,
  compare = "identical",
  runs = [],
} = {}) {
  return vi.fn(async (route) => {
    if (route.endsWith("/branches/main")) return { commit: { sha: main } };
    if (route.includes("/compare/")) return { status: compare };
    if (route.includes("/actions/workflows/"))
      return {
        workflow_runs: [
          {
            head_sha: commit,
            head_branch: "main",
            repository: { full_name: repo },
            event: "push",
            run_number: 1,
            run_attempt: 1,
            status: "completed",
            conclusion: route.includes("ci.yml") ? ci : platform,
          },
          ...runs,
        ],
      };
    if (route.includes("/contents/package.json"))
      return { content: Buffer.from('{"version":"2.8.0"}').toString("base64") };
    if (route.includes("/releases?")) return release ? [release] : [];
    if (route.includes("/git/ref/tags/")) return ref;
    throw Error(`Unexpected test API route ${route}`);
  });
}
describe("release gates", () => {
  it("requires both exact-commit latest main workflow successes", async () => {
    expect((await releaseGate({ api: gateApi(), repository: repo, commit })).ready).toBe(true);
    for (const opts of [
      { ci: "failure" },
      { platform: "failure" },
      {
        runs: [
          {
            head_sha: commit,
            head_branch: "main",
            repository: { full_name: repo },
            event: "workflow_dispatch",
            run_number: 2,
            run_attempt: 1,
            status: "in_progress",
            conclusion: null,
          },
        ],
      },
    ])
      expect((await releaseGate({ api: gateApi(opts), repository: repo, commit })).ready).toBe(false);
  });
  it("never treats a successful unrelated SHA or PR run as verification", async () => {
    const api = gateApi();
    const wrapped = async (route, opts) => {
      const value = await api(route, opts);
      if (value?.workflow_runs)
        value.workflow_runs = value.workflow_runs.map((r) => ({ ...r, head_sha: "c".repeat(40) }));
      return value;
    };
    expect((await releaseGate({ api: wrapped, repository: repo, commit })).ready).toBe(false);
    const untrusted = {
      head_sha: commit,
      head_branch: "main",
      head_repository: { full_name: "foreign/fork" },
      event: "push",
    };
    expect(
      (await releaseGate({ api, repository: repo, commit, event: "workflow_run", trigger: untrusted })).ready,
    ).toBe(false);
  });
  it("waits for the second completion, rejects unreachable commits, skips superseded automatic candidates", async () => {
    expect((await releaseGate({ api: gateApi({ platform: null }), repository: repo, commit })).ready).toBe(false);
    await expect(releaseGate({ api: gateApi({ compare: "diverged" }), repository: repo, commit })).rejects.toThrow(
      /reachable/,
    );
    expect(
      (
        await releaseGate({
          api: gateApi({ main: "c".repeat(40), compare: "ahead" }),
          repository: repo,
          commit,
          event: "workflow_run",
          trigger: { head_sha: commit, head_branch: "main", head_repository: { full_name: repo }, event: "push" },
        })
      ).ready,
    ).toBe(false);
  });
  it("skips already-published versions and only resumes drafts/tags bound to the same commit", async () => {
    expect(
      (await releaseGate({ api: gateApi({ release: { tag_name: "v2.8.0", draft: false } }), repository: repo, commit }))
        .ready,
    ).toBe(false);
    expect(
      (
        await releaseGate({
          api: gateApi({
            release: { tag_name: "v2.8.0", draft: true, target_commitish: commit, id: 8 },
            ref: { object: { type: "commit", sha: commit } },
          }),
          repository: repo,
          commit,
        })
      ).draftId,
    ).toBe(8);
    await expect(
      releaseGate({
        api: gateApi({ release: { tag_name: "v2.8.0", draft: true, target_commitish: "wrong" } }),
        repository: repo,
        commit,
      }),
    ).rejects.toThrow(/different commit/);
    await expect(
      releaseGate({
        api: gateApi({ ref: { object: { type: "commit", sha: "c".repeat(40) } } }),
        repository: repo,
        commit,
      }),
    ).rejects.toThrow(/different commit/);
  });
  it("fails API authentication errors instead of treating them as absent tags", async () => {
    const client = githubClient({ token: "test-only", fetchImpl: async () => ({ ok: false, status: 403 }) });
    await expect(client("/repos/irongeeks/ironcrew/git/ref/tags/v2.8.0", { allow404: true })).rejects.toThrow(/403/);
    await expect(client("https://external.invalid/token")).rejects.toThrow(/non-GitHub/);
  });
});
describe("source packages", () => {
  it("packages only the exact committed source with deterministic archives and matching checksums", () => {
    const f = repository(),
      out = path.join(f.dir, "out"),
      again = path.join(f.dir, "again");
    fs.writeFileSync(path.join(f.dir, ".env"), "untracked-secret");
    const a = createReleasePackage({ root: f.dir, commit: f.commit, outDir: out, imageDigest: digest });
    const b = createReleasePackage({ root: f.dir, commit: f.commit, outDir: again, imageDigest: digest });
    expect(a).toEqual(b);
    const archive = fs.readFileSync(path.join(out, a.source.file));
    expect(sha256(archive)).toBe(a.source.sha256);
    expect(gunzipSync(archive).includes(Buffer.from("untracked-secret"))).toBe(false);
    expect(gunzipSync(archive).includes(Buffer.from("ironcrew-2.8.0/README.md"))).toBe(true);
    const sums = fs.readFileSync(path.join(out, "SHA256SUMS"), "utf8");
    expect(sums).toContain(
      `${sha256(fs.readFileSync(path.join(out, "release-manifest.json")))}  release-manifest.json`,
    );
  });
  it("rejects tracked private data, invalid versions and abbreviated source refs", () => {
    const f = repository();
    expect(() => createReleasePackage({ root: f.dir, commit: "HEAD", outDir: path.join(f.dir, "out") })).toThrow(
      /full commit/,
    );
    fs.writeFileSync(path.join(f.dir, ".env"), "private");
    f.git(["add", ".env"]);
    f.git(["commit", "-qm", "badfixture"]);
    expect(() =>
      createReleasePackage({ root: f.dir, commit: f.git(["rev-parse", "HEAD"]), outDir: path.join(f.dir, "out") }),
    ).toThrow(/Private/);
  });
});
describe("image and draft retry safety", () => {
  it("reuses a previously published version image only with matching immutable OCI identity", async () => {
    const run = vi.fn(),
      smoke = vi.fn();
    const args = {
      getDigest: async () => digest,
      run,
      smoke,
      inspect: () => ({ "org.opencontainers.image.revision": commit, "org.opencontainers.image.version": "2.8.0" }),
      image: `ghcr.io/${repo}:v2.8.0`,
      version: "2.8.0",
      commit,
      repository: repo,
    };
    expect(await ensureVersionImage(args)).toBe(digest);
    expect(run.mock.calls.map((c) => c[0][0])).toEqual(["pull"]);
    await expect(
      ensureVersionImage({ ...args, inspect: () => ({ "org.opencontainers.image.revision": "other" }) }),
    ).rejects.toThrow(/overwrite/);
  });
  it("never pushes a build that failed smoke or races an existing version", async () => {
    const run = vi.fn();
    const args = {
      getDigest: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(digest),
      run,
      smoke: vi.fn(),
      image: `ghcr.io/${repo}:v2.8.0`,
      version: "2.8.0",
      commit,
      repository: repo,
    };
    await expect(ensureVersionImage(args)).rejects.toThrow(/appeared/);
    expect(run.mock.calls.map((c) => c[0][0])).toEqual(["build"]);
    run.mockClear();
    await expect(
      ensureVersionImage({
        ...args,
        getDigest: async () => null,
        smoke: () => {
          throw Error("unhealthy");
        },
      }),
    ).rejects.toThrow(/unhealthy/);
    expect(run.mock.calls.map((c) => c[0][0])).toEqual(["build"]);
  });
  it("uploads only missing matching draft assets and publishes after integrity checks", async () => {
    const f = repository(),
      out = path.join(f.dir, "out");
    const manifest = createReleasePackage({ root: f.dir, commit: f.commit, outDir: out, imageDigest: digest });
    const existingBytes = fs.readFileSync(path.join(out, manifest.source.file));
    const draft = {
      id: 8,
      draft: true,
      tag_name: "v2.8.0",
      target_commitish: f.commit,
      assets: [
        {
          name: manifest.source.file,
          state: "uploaded",
          size: existingBytes.length,
          digest: `sha256:${sha256(existingBytes)}`,
        },
      ],
      upload_url: "https://uploads.github.com/repos/irongeeks/ironcrew/releases/8/assets{?name,label}",
    };
    const base = gateApi({ release: { ...draft, target_commitish: commit } });
    const calls = [];
    const api = async (route, options = {}) => {
      calls.push([route, options]);
      if (route.endsWith("/releases/8")) return options.method === "PATCH" ? { ...draft, draft: false } : draft;
      if (route.startsWith("https://uploads.github.com/"))
        return { digest: `sha256:${sha256(options.bytes)}`, size: options.bytes.length };
      const value = await base(route.replaceAll(f.commit, commit), options);
      if (value?.workflow_runs) value.workflow_runs = value.workflow_runs.map((r) => ({ ...r, head_sha: f.commit }));
      if (route.includes("/branches/")) value.commit.sha = f.commit;
      if (route.includes("/releases?")) return [draft];
      return value;
    };
    expect((await publishRelease({ api, repository: repo, outDir: out })).published).toBe(true);
    expect(calls.filter(([u]) => u.startsWith("https://uploads."))).toHaveLength(2);
    expect(calls.at(-1)[1]).toEqual({ method: "PATCH", body: { draft: false } });
    draft.assets[0].digest = "sha256:changed";
    await expect(publishRelease({ api, repository: repo, outDir: out })).rejects.toThrow(/refusing overwrite/);
  });
});
it("keeps release jobs narrowly permissioned and runs dry-run checks for pull requests", () => {
  const workflow = yaml.load(fs.readFileSync(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8"));
  expect(workflow.on.workflow_run.workflows).toEqual(["CI", "Platform and production verification"]);
  expect(workflow.jobs.gate.permissions).toEqual({ contents: "read", actions: "read" });
  expect(workflow.jobs.publish.permissions).toEqual({ contents: "write", actions: "read", packages: "write" });
  expect(workflow.jobs["package-check"].if).toContain("pull_request");
  expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
});

it("uses publishing scope for first-package preflight and never converts auth failures to absence", async () => {
  const fetchImpl = vi.fn(async (url) => {
    const scope = url.searchParams.get("scope");
    return {
      ok: true,
      status: 200,
      json: async () => ({
        token: scope === "repository:irongeeks/ironcrew:pull,push" ? "publishing-token" : "anonymous-token",
      }),
    };
  });
  expect(await ghcrRegistryToken({ repository: repo, actor: "ci-actor", token: "test-only", fetchImpl })).toBe(
    "publishing-token",
  );
  expect(fetchImpl.mock.calls[0][0].searchParams.get("scope")).toBe("repository:irongeeks/ironcrew:pull,push");
  expect(await ghcrRegistryToken({ repository: repo, authenticated: false, fetchImpl })).toBe("anonymous-token");
  expect(fetchImpl.mock.calls[1][1].headers).toEqual({});
  await expect(
    ghcrRegistryToken({
      repository: repo,
      actor: "ci-actor",
      token: "test-only",
      fetchImpl: async () => ({ ok: false, status: 403 }),
    }),
  ).rejects.toThrow(/403/);
});
