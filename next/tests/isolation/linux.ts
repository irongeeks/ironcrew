/** Mandatory Linux gate. Missing runtime/delegation is a failure, never a skip. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, symlink, link, rm, readdir } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { loadExecutionPort, isVerifiedExecutionPort } from "../../packages/tools/isolation/index.ts";
const [profilePath, evidencePath] = process.argv.slice(2);
assert.equal(process.platform, "linux");
assert.ok(profilePath && evidencePath, "linux.ts PROFILE EVIDENCE");
const port = await loadExecutionPort(profilePath);
assert.equal(isVerifiedExecutionPort(port), true);
assert.equal(isVerifiedExecutionPort({ execute: port.execute.bind(port), attestation: port.attestation }), false);
assert.throws(() => {
  port.profile.limits.memoryBytes = 4_294_967_296;
}, TypeError);
assert.throws(() => {
  port.attestation.expiresAt = "2999-01-01T00:00:00Z";
}, TypeError);
const directory = await mkdtemp(path.join(tmpdir(), "ironcrew-isolation-check-"));
try {
  const workspace = path.join(directory, "workspace"),
    outside = path.join(directory, "secret");
  await mkdir(workspace);
  await writeFile(outside, "HOST_SECRET_MUST_NOT_CROSS");
  await writeFile(path.join(workspace, "source.txt"), "immutable-input");
  const result = await port.execute({
    workspaceRoot: workspace,
    argv: [
      "node",
      "-e",
      "require('node:fs').mkdirSync('dist');require('node:fs').writeFileSync('dist/result.txt','actual-output');",
    ],
    outputPaths: ["dist"],
  });
  assert.equal(result.exitCode, 0);
  assert.equal(await readFile(path.join(result.outputDirectory, "dist/result.txt"), "utf8"), "actual-output");
  assert.deepEqual(Object.keys(result.outputHashes), ["dist/result.txt"]);
  assert.deepEqual(await readdir(workspace), ["source.txt"]);
  await symlink(outside, path.join(workspace, "escape"));
  await assert.rejects(
    () => port.execute({ workspaceRoot: workspace, argv: ["node", "-e", "process.exit(0)"] }),
    /unsafe_input_path/,
  );
  await rm(path.join(workspace, "escape"));
  await link(outside, path.join(workspace, "hardlink"));
  await assert.rejects(
    () => port.execute({ workspaceRoot: workspace, argv: ["node", "-e", "process.exit(0)"] }),
    /unsafe_input_path/,
  );
  await rm(path.join(workspace, "hardlink"));
  await assert.rejects(
    () => port.execute({ workspaceRoot: workspace, argv: ["node", "-e", ""], outputPaths: ["../secret"] }),
    /execution_output_path_invalid/,
  );
  const orphan = await port.execute({
    workspaceRoot: workspace,
    argv: [
      "node",
      "-e",
      "const c=require('node:child_process').spawn('/bin/sh',['-c','while true; do sleep 1; done'],{detached:true,stdio:'ignore'});c.unref();while(true){}",
    ],
    timeoutMs: 500,
  });
  assert.equal(orphan.termination, "timeout");
  assert.equal((await readdir(port.profile.cgroupRoot)).filter((name) => name.startsWith("job-")).length, 0);
  await writeFile(
    evidencePath,
    JSON.stringify(
      {
        attestation: port.attestation,
        actualOutput: result,
        inputSymlinkRejected: true,
        inputHardlinkRejected: true,
        traversalRejected: true,
        detachedChildrenReaped: true,
        forgedPortRejected: true,
        immutableAttestation: true,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify({ passed: true, probes: Object.keys(port.attestation.probes).length, evidencePath }));
} finally {
  await rm(directory, { recursive: true, force: true });
}
