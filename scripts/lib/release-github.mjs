import process from "node:process";
import { Buffer } from "node:buffer";
import { URL } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { SHA, DIGEST, sha256, validateVersion } from "./release-packaging.mjs";
const REQUIRED = ["ci.yml", "platform-production.yml"];
export function githubClient({ token, fetchImpl = globalThis.fetch }) {
  if (!token) throw new Error("GitHub token is required.");
  return async (route, { method = "GET", body, bytes, allow404 = false } = {}) => {
    const url = route.startsWith("https://") ? new URL(route) : new URL(`https://api.github.com${route}`);
    if (!["api.github.com", "uploads.github.com"].includes(url.hostname) || url.protocol !== "https:")
      throw new Error("Refusing non-GitHub API URL.");
    const response = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(bytes
          ? { "Content-Type": "application/octet-stream" }
          : body
            ? { "Content-Type": "application/json" }
            : {}),
      },
      body: bytes ?? (body ? JSON.stringify(body) : undefined),
      signal: globalThis.AbortSignal.timeout(120000),
      redirect: "error",
    });
    if (allow404 && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub ${method} ${url.pathname} failed (${response.status}).`);
    return response.status === 204 ? null : response.json();
  };
}
export async function releaseGate({ api, repository, commit, event = "workflow_dispatch", trigger }) {
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repository) || !SHA.test(commit))
    throw new Error("Invalid release identity.");
  if (
    event === "workflow_run" &&
    (!trigger ||
      trigger.head_sha !== commit ||
      trigger.head_branch !== "main" ||
      trigger.head_repository?.full_name !== repository ||
      !["push", "workflow_dispatch"].includes(trigger.event))
  )
    return { ready: false, reason: "Untrusted or non-main workflow event." };
  const base = `/repos/${repository}`;
  const branch = await api(`${base}/branches/main`);
  const compare = await api(`${base}/compare/${commit}...${branch.commit.sha}`);
  if (!["ahead", "identical"].includes(compare.status)) throw new Error("Release commit is not reachable from main.");
  // Old completions never release a superseded main version; a dispatch may deliberately select a checked ancestor.
  if (event === "workflow_run" && branch.commit.sha !== commit)
    return { ready: false, reason: "Main has advanced; wait for verification of its current commit." };
  for (const workflow of REQUIRED) {
    const data = await api(`${base}/actions/workflows/${workflow}/runs?head_sha=${commit}&branch=main&per_page=100`);
    const matches = data.workflow_runs
      .filter(
        (r) =>
          r.head_sha === commit &&
          r.head_branch === "main" &&
          r.repository?.full_name === repository &&
          ["push", "workflow_dispatch"].includes(r.event),
      )
      .sort((a, b) => b.run_number - a.run_number || b.run_attempt - a.run_attempt);
    if (!matches[0] || matches[0].status !== "completed" || matches[0].conclusion !== "success")
      return { ready: false, reason: `Latest exact-commit ${workflow} verification has not succeeded.` };
  }
  const pkg = await api(`${base}/contents/package.json?ref=${commit}`);
  const version = validateVersion(JSON.parse(Buffer.from(pkg.content, "base64").toString("utf8")).version);
  const tag = `v${version}`;
  // List includes drafts for the authenticated release writer; tag lookup alone can omit draft state.
  let release = null;
  for (let page = 1; page <= 20; page++) {
    const rows = await api(`${base}/releases?per_page=100&page=${page}`);
    release = rows.find((r) => r.tag_name === tag);
    if (release || rows.length < 100) break;
    if (page === 20) throw new Error("Release inventory exceeds bounded scan.");
  }
  if (release && !release.draft)
    return { ready: false, reason: `${tag} is already published; nothing will be overwritten.` };
  if (release && release.target_commitish !== commit) throw new Error("Existing draft belongs to a different commit.");
  let ref = await api(`${base}/git/ref/tags/${tag}`, { allow404: true });
  if (ref) {
    let object = ref.object;
    for (let depth = 0; object.type === "tag" && depth < 5; depth++)
      object = (await api(`${base}/git/tags/${object.sha}`)).object;
    if (object.type !== "commit" || object.sha !== commit)
      throw new Error("Existing release tag points to a different commit.");
  }
  return { ready: true, version, tag, commit, repository, draftId: release?.id ?? null };
}
export async function publishRelease({ api, repository, outDir }) {
  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, "release-manifest.json"), "utf8"));
  validateVersion(manifest.version);
  if (
    manifest.schemaVersion !== 1 ||
    !SHA.test(manifest.commit) ||
    manifest.tag !== `v${manifest.version}` ||
    !DIGEST.test(manifest.container?.digest ?? "")
  )
    throw new Error("Cannot publish an incomplete release manifest.");
  if (manifest.container.image !== `ghcr.io/${repository.toLowerCase()}:${manifest.tag}`)
    throw new Error("Manifest image belongs to another release.");
  const names = [manifest.source.file, "release-manifest.json", "SHA256SUMS"];
  if (manifest.source.file !== `ironcrew-${manifest.version}-source.tar.gz`)
    throw new Error("Invalid source asset name.");
  const source = fs.readFileSync(path.join(outDir, manifest.source.file));
  if (sha256(source) !== manifest.source.sha256 || source.length !== manifest.source.size)
    throw new Error("Source asset does not match manifest.");
  const expectedSums = `${sha256(source)}  ${manifest.source.file}\n${sha256(fs.readFileSync(path.join(outDir, "release-manifest.json")))}  release-manifest.json\n`;
  if (fs.readFileSync(path.join(outDir, "SHA256SUMS"), "utf8") !== expectedSums)
    throw new Error("Release checksum list does not match local artifacts.");
  const base = `/repos/${repository}`;
  const gate = await releaseGate({ api, repository, commit: manifest.commit });
  if (!gate.ready) return { published: false, reason: gate.reason };
  if (gate.version !== manifest.version || gate.tag !== manifest.tag)
    throw new Error("Manifest version does not match the verified commit package version.");
  const notesPath = path.join(process.cwd(), "docs", "releases", `${manifest.tag}.md`);
  const notes = fs.existsSync(notesPath) ? fs.readFileSync(notesPath, "utf8") + "\n\n" : "";
  let release = gate.draftId
    ? await api(`${base}/releases/${gate.draftId}`)
    : await api(`${base}/releases`, {
        method: "POST",
        body: {
          tag_name: manifest.tag,
          target_commitish: manifest.commit,
          name: `IronCrew ${manifest.version}`,
          draft: true,
          prerelease: false,
          body: `${notes}Versioned source and linux/amd64 control-plane image.\n\nCommit: ${manifest.commit}\nImage: ${manifest.container.image}@${manifest.container.digest}\n\nVerify SHA256SUMS before installation. Existing private GHCR packages may require docker login; package visibility is not changed by this workflow.`,
        },
      });
  if (!release.draft || release.target_commitish !== manifest.commit)
    throw new Error("Release is no longer the expected draft.");
  for (const name of names) {
    const bytes = fs.readFileSync(path.join(outDir, name));
    const existing = release.assets.find((a) => a.name === name);
    if (existing) {
      if (
        existing.state !== "uploaded" ||
        existing.digest !== `sha256:${sha256(bytes)}` ||
        existing.size !== bytes.length
      )
        throw new Error(`Existing draft asset differs or is incomplete: ${name}; refusing overwrite.`);
      continue;
    }
    const upload = new URL(release.upload_url.split("{")[0]);
    upload.searchParams.set("name", name);
    const asset = await api(upload.href, { method: "POST", bytes });
    if (asset.digest !== `sha256:${sha256(bytes)}` || asset.size !== bytes.length)
      throw new Error(`Uploaded asset integrity failed: ${name}`);
  }
  // Explicitly select the new 0.1.x line despite the retired 2.8.0 tag. A manual
  // ancestor release or a superseded build must not replace the current latest.
  const main = await api(`${base}/branches/main`);
  await api(`${base}/releases/${release.id}`, {
    method: "PATCH",
    body: { draft: false, make_latest: main.commit.sha === manifest.commit ? "true" : "false" },
  });
  return { published: true, tag: manifest.tag };
}

/** A publishing preflight requests the same pull,push scope as a Docker push, including first package creation. */
export async function ghcrRegistryToken({
  repository,
  authenticated = true,
  actor,
  token,
  fetchImpl = globalThis.fetch,
}) {
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repository)) throw new Error("Invalid registry repository.");
  if (authenticated && (!actor || !token))
    throw new Error("Authenticated GHCR preflight requires workflow credentials.");
  const url = new URL("https://ghcr.io/token");
  url.searchParams.set("service", "ghcr.io");
  url.searchParams.set("scope", `repository:${repository}:${authenticated ? "pull,push" : "pull"}`);
  const response = await fetchImpl(url, {
    headers: authenticated ? { Authorization: `Basic ${Buffer.from(`${actor}:${token}`).toString("base64")}` } : {},
    signal: globalThis.AbortSignal.timeout(30000),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`GHCR token request failed (${response.status}).`);
  const body = await response.json();
  if (typeof body.token !== "string") throw new Error("GHCR did not return a registry token.");
  return body.token;
}
