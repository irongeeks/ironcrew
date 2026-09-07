import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { loadExecutionPort } from "../packages/tools/isolation/index.ts";
import { Repository } from "../packages/persistence/src/index.ts";
import { WebsiteWorkflow } from "../packages/domain/workflows/website.ts";
import { digest } from "../packages/tools/workspace.ts";
const [profilePath, outputDirectory] = process.argv.slice(2);
if (!profilePath || !outputDirectory) throw new Error("Usage: site-build-lab.ts profile.json output-directory");
await mkdir(outputDirectory, { recursive: true });
const port = await loadExecutionPort(profilePath),
  directory = await mkdtemp(path.join(tmpdir(), "site-build-lab-"));
const repo = await Repository.open(path.join(directory, "company.sqlite"));
const evidence: unknown[] = [];
try {
  const setup = await repo.setup({
    companyName: "Isolated build lab",
    ceoName: "Fixture CEO",
    passwordHash: "fixture",
    timezone: "UTC",
    budgetLimitUsdMicros: "0",
  });
  const scope = { companyId: setup.company.id, areaId: setup.areas[0]!.id };
  const web = new WebsiteWorkflow(repo, directory, async () => port);
  for (const stack of ["react", "wordpress"] as const) {
    const order = await repo.createOrder(scope, {
      kind: "website",
      goal: `Real ${stack} offline build`,
      budgetLimitUsdMicros: "0",
    });
    await web.create(scope, order.id, "Offline website build with actual Linux isolation", stack);
    const concepts = await web.concepts(scope, order.id, [
      {
        name: "Chosen",
        rationale: "Fixture",
        html: '<!doctype html><html lang="de"><head><title>Build lab</title><style>body{color:#123456}</style></head><body><h1>Isolated website fixture</h1><details><summary>Details</summary><p>Build evidence</p></details></body></html>',
      },
      { name: "Alternative", rationale: "Fixture", html: "<h1>Alternative</h1>" },
    ]);
    await web.select(scope, order.id, concepts.data.concepts[0]!.id);
    const artifact = await web.build(scope, order.id);
    const execution = artifact.buildEvidence as {
      exitCode: number;
      attestationId: string;
      outputHashes: Record<string, string>;
      php?: { exitCode: number };
    };
    assert.equal(execution.exitCode, 0);
    assert.ok(execution.attestationId);
    assert.ok(execution.outputHashes["dist/index.html"]);
    if (stack === "wordpress") assert.equal(execution.php?.exitCode, 0);
    assert.ok((await web.preview(artifact.id)).length > 0);
    const archive = await web.packageArchive(scope, artifact.id),
      repeated = await web.packageArchive(scope, artifact.id);
    assert.equal(archive.sha256, repeated.sha256);
    await writeFile(path.join(outputDirectory, stack + ".tar.gz"), archive.content);
    await writeFile(path.join(outputDirectory, stack + "-artifact.json"), JSON.stringify(artifact, null, 2) + "\n");
    const original = await readFile(path.join(directory, "sites", artifact.id, "dist/index.html"));
    await writeFile(path.join(directory, "sites", artifact.id, "dist/index.html"), "tampered");
    await assert.rejects(() => web.preview(artifact.id), /artifact_corrupt/);
    await assert.rejects(() => web.packageArchive(scope, artifact.id), /artifact_corrupt/);
    await writeFile(path.join(directory, "sites", artifact.id, "dist/index.html"), original);
    evidence.push({
      stack,
      artifactVersionId: artifact.id,
      packageSha256: artifact.packageSha256,
      archiveSha256: digest(archive.content),
      execution,
      tamperRejected: true,
      deterministicArchive: true,
    });
  }
  await writeFile(
    path.join(outputDirectory, "site-build-evidence.json"),
    JSON.stringify(
      {
        testedAt: new Date().toISOString(),
        platform: process.platform,
        node: process.version,
        attestation: port.attestation,
        builds: evidence,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify({ passed: true, builds: evidence }));
} finally {
  await repo.close();
  await rm(directory, { recursive: true, force: true });
}
