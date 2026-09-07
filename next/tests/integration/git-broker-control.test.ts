import { createFixtureLauncher } from "../fixtures/launcher.ts";
import { fixtureGitExecutable } from "../fixtures/git.ts";
import { beforeEach, afterEach, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { Repository } from "../../packages/persistence/src/index.ts";
import {
  configSchema,
  saveConfiguration,
  configuredRuntime,
  workflowIntegrationPort,
} from "../../apps/control/configuration.ts";
import { localRuntimeTools } from "../../apps/control/git-broker.ts";
import { ResearchService } from "../../packages/domain/workflows/research.ts";
import { sha256 } from "../../packages/domain/src/index.ts";
import type { Scope, ToolAction, ApprovalBinding } from "../../packages/contracts/src/index.ts";
const exec = promisify(execFile);
let directory: string, repo: Repository, scope: Scope, orderId: string;
beforeEach(async () => {
  directory = await realpath(await mkdtemp(path.join(tmpdir(), "ironcrew-local-control-")));
  repo = await Repository.open(path.join(directory, "company.sqlite"));
  const setup = await repo.setup({
    companyName: "Control fixture",
    ceoName: "CEO",
    passwordHash: "fixture",
    timezone: "UTC",
    budgetLimitUsdMicros: "0",
  });
  scope = { companyId: setup.company.id, areaId: setup.areas[0].id };
  orderId = (await repo.createOrder(scope, { kind: "research", goal: "Git delivery", budgetLimitUsdMicros: "0" })).id;
});
afterEach(async () => {
  await repo.close();
  await rm(directory, { recursive: true, force: true });
});
async function mandate(targetId: string, allowedToolIds: string[]) {
  const mandate = {
    id: randomUUID(),
    version: 1,
    scope,
    targetIds: [targetId],
    allowedToolIds,
    parameterConstraints: {},
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    maxAttempts: 5,
    maxDurationSeconds: 60,
    maxCostUsdMicros: "0",
  };
  await repo.createMandate(mandate);
  return mandate;
}
async function approve(actionId: string) {
  const pending = await repo.getDocument<{ binding: ApprovalBinding }>(scope, "approval-request", actionId);
  const approved = await repo.approve(scope, pending!.data.binding);
  const record = await repo.getDocument<ToolAction>(scope, "action", actionId);
  await repo.putDocument(
    scope,
    "action",
    actionId,
    { ...record!.data, approvalId: approved.id, status: "authorized" },
    { expectedRevision: record!.revision },
  );
}
async function gitConfig() {
  const gitExecutable = await fixtureGitExecutable();
  const source = path.join(directory, "source"),
    remote = path.join(directory, "remote.git");
  await mkdir(source);
  const git = (args: string[]) =>
    exec(
      gitExecutable,
      ["-c", "core.autocrlf=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.org", ...args],
      { cwd: source },
    );
  await git(["init", "--initial-branch=main"]);
  await git(["init", "--bare", "--initial-branch=main", remote]);
  await writeFile(path.join(source, "README.md"), "Seed\n");
  await git(["add", "README.md"]);
  await git(["commit", "-m", "Seed"]);
  await git(["remote", "add", "origin", remote]);
  const head = (await git(["rev-parse", "HEAD"])).stdout.trim();
  const target = {
    id: randomUUID(),
    scope,
    repositoryPath: source,
    workspaceRoot: path.join(directory, "workspaces"),
    gitExecutable,
    sourceBranch: "main",
    remoteName: "origin",
    remoteUrl: remote,
    remoteBranch: "main",
    authorName: "Fixture",
    authorEmail: "fixture@example.org",
    allowLocalRemote: true,
  };
  const config = configSchema.parse({ liveExecutionEnabled: true, gitConnections: [target] });
  await saveConfiguration(directory, config);
  return { target, config, head, git };
}
async function serviceConfig(failRestart = false) {
  const log = path.join(directory, "broker.log");
  const executable = await createFixtureLauncher(
    directory,
    "docker-fixture",
    failRestart
      ? `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(log)}, 'attempt\\n'); process.exit(2);\n`
      : `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ')+'\\n'); if(process.argv.includes('inspect')) console.log(JSON.stringify({Status:'running',Running:true,ExitCode:0}));\n`,
  );
  const target = { id: randomUUID(), scope, kind: "docker" as const, resourceName: "fixture-container", executable };
  const config = configSchema.parse({ liveExecutionEnabled: true, serviceTargets: [target] });
  await saveConfiguration(directory, config);
  return { target, config, log };
}
it("validates trusted target paths, scopes, uniqueness and exposes local runtime tools", async () => {
  const f = await gitConfig();
  expect(() => configSchema.parse({ gitConnections: [{ ...f.target, gitExecutable: "git" }] })).toThrow();
  expect(() => configSchema.parse({ gitConnections: [f.target, f.target] })).toThrow();
  expect(() =>
    configSchema.parse({
      serviceTargets: [
        { id: randomUUID(), scope, kind: "windows", resourceName: "service';bad", executable: "/fixture/powershell" },
      ],
    }),
  ).toThrow();
  const secretRef = { provider: "proton-pass", shareId: "share", itemId: "item", field: "password" };
  const runtime = await configuredRuntime(
    repo,
    directory,
    configSchema.parse({ ...f.config, proton: { executable: "/fixture/pass-cli" }, openrouter: { secretRef } }),
    [],
  );
  expect(runtime!.tools.filter((tool) => tool.id.startsWith("git."))).toHaveLength(2);
  expect(runtime!.tools.find((tool) => tool.id === "git.push")!.requiresApproval).toBe(true);
  expect(
    (await runtime!.localTools(orderId, { ...scope, areaId: randomUUID() })).some((tool) => tool.id.startsWith("git.")),
  ).toBe(false);
  const description = (await runtime!.localTools(orderId, scope)).find((tool) => tool.id === "git.push")!.description;
  const targets = JSON.parse(description.split("Administrative targets: ")[1]!);
  expect(targets).toEqual([
    {
      targetId: f.target.id,
      targetConfigSha256: sha256(f.config.gitConnections[0]),
      destination: { remote: f.target.remoteUrl, branch: f.target.sourceBranch },
    },
  ]);
  expect(runtime!.tools.filter((tool) => tool.id.endsWith(".restart")).every((tool) => tool.requiresApproval)).toBe(
    true,
  );
});
it("delivers research through a real staged commit and durable approval replay to a local bare remote", async () => {
  const f = await gitConfig(),
    m = await mandate(f.target.id, ["git.stage", "git.push"]);
  const source = {
    id: "source",
    title: "Fixture source",
    url: "https://example.org/source",
    observedAt: new Date().toISOString(),
    status: "available" as const,
    contentSha256: "a".repeat(64),
  };
  await repo.putDocument(scope, "research-source", source.id, source, { immutable: true });
  const port = await workflowIntegrationPort(repo, directory, scope, orderId, m.id);
  const research = new ResearchService(repo, directory, port);
  const artifact = await research.create(scope, {
    orderId,
    title: "Report",
    recommendation: "Use evidence",
    reasons: [{ text: "Supported", sourceIds: [source.id] }],
    comparison: "Fixture",
    methodology: "Fixture evidence",
    sources: [source],
    assumptions: [],
    gaps: [],
    requiredDelivery: "git",
  });
  const input = {
    targetId: f.target.id,
    expectedRevision: f.head,
    expectedRemoteHead: null,
    path: "reports/research.md",
  };
  const pending = await research.deliver(scope, artifact.id, input);
  expect(pending.state).toBe("approval");
  expect(pending.gitCommit).toMatch(/^[a-f0-9]{40}$/);
  expect((await f.git(["show", `${pending.gitCommit}:reports/research.md`])).stdout).toContain("Use evidence");
  expect((await f.git(["ls-remote", "origin"])).stdout).toBe("");
  await expect(research.deliver(scope, artifact.id, { ...input, path: "changed.md" })).rejects.toThrow(
    "delivery_staged_binding_changed",
  );
  await expect(research.deliver(scope, artifact.id, { ...input, expectedRemoteHead: f.head })).rejects.toThrow(
    "delivery_approval_binding_changed",
  );
  await approve(pending.actionId!);
  const resumed = new ResearchService(
    repo,
    directory,
    await workflowIntegrationPort(repo, directory, scope, orderId, m.id),
  );
  const delivered = await resumed.deliver(scope, artifact.id, input);
  expect(delivered.state).toBe("delivered");
  expect(delivered.externalRevision).toBe(pending.gitCommit);
  expect((await f.git(["ls-remote", "origin", "refs/heads/main"])).stdout).toContain(pending.gitCommit);
  expect(await resumed.deliver(scope, artifact.id, input)).toEqual(delivered);
  expect(await repo.listDocuments(scope, "action")).toHaveLength(2);
});
it("executes a configured service process only after concrete restart approval and deduplicates replay", async () => {
  const f = await serviceConfig(),
    m = await mandate(f.target.id, ["docker.container.status", "docker.container.restart"]);
  const port = await workflowIntegrationPort(repo, directory, scope, orderId, m.id);
  const status = await port.execute({
    id: randomUUID(),
    scope,
    targetId: f.target.id,
    toolId: "docker.container.status",
    args: {},
  });
  expect(status.data).toMatchObject({ status: "running" });
  const input = { id: randomUUID(), scope, targetId: f.target.id, toolId: "docker.container.restart", args: {} };
  await expect(port.execute(input)).rejects.toMatchObject({ code: "approval_required" });
  expect(await readFile(f.log, "utf8")).not.toContain("restart");
  const pending = await repo.getDocument<{ args: unknown }>(scope, "approval-request", input.id);
  expect(pending!.data.args).toMatchObject({
    parameters: { resourceName: "fixture-container" },
    targetConfigSha256: sha256(f.config.serviceTargets[0]),
  });
  await approve(input.id);
  expect((await port.execute(input)).effectStatus).toBe("accepted");
  await port.execute(input);
  expect((await readFile(f.log, "utf8")).match(/restart/g)).toHaveLength(1);
});
it("rejects cross-scope and cross-kind local target dispatch before any native process", async () => {
  const f = await serviceConfig(),
    m = await mandate(f.target.id, ["docker.container.status", "linux.service.status"]);
  const port = await workflowIntegrationPort(repo, directory, scope, orderId, m.id);
  await expect(
    port.execute({
      id: randomUUID(),
      scope: { ...scope, areaId: randomUUID() },
      targetId: f.target.id,
      toolId: "docker.container.status",
      args: {},
    }),
  ).rejects.toMatchObject({ code: "integration_scope_mismatch" });
  await expect(
    port.execute({ id: randomUUID(), scope, targetId: f.target.id, toolId: "linux.service.status", args: {} }),
  ).rejects.toMatchObject({ code: "authorization" });
  await expect(readFile(f.log)).rejects.toMatchObject({ code: "ENOENT" });
});
it("runtime adapter rechecks stored target, arguments and approval without creating nested actions", async () => {
  const f = await serviceConfig(),
    m = await mandate(f.target.id, ["docker.container.status", "docker.container.restart"]);
  const tools = localRuntimeTools(repo, f.config);
  const args = { targetId: f.target.id, targetConfigSha256: sha256(f.config.serviceTargets[0]), parameters: {} };
  const action = {
    id: randomUUID(),
    runId: orderId,
    orderId,
    scope,
    toolId: "docker.container.status",
    toolVersion: 1,
    args,
    argumentsSha256: sha256(args),
    status: "running" as const,
    mandateId: m.id,
    mandateVersion: 1,
    evidenceRefs: [],
    targetId: f.target.id,
  };
  await repo.putDocument(scope, "action", action.id, action);
  const status = tools.find((tool) => tool.id === action.toolId)!;
  await expect(status.execute({ ...args, targetId: randomUUID() }, action)).rejects.toMatchObject({
    code: "authorization",
  });
  expect(await status.execute(args, action)).toMatchObject({ data: { status: "running" } });
  const restart = { ...action, id: randomUUID(), toolId: "docker.container.restart" };
  await repo.putDocument(scope, "action", restart.id, restart);
  await expect(tools.find((tool) => tool.id === restart.toolId)!.execute(args, restart)).rejects.toThrow();
  expect(await readFile(f.log, "utf8")).not.toContain("restart");
  expect(await repo.listDocuments(scope, "action")).toHaveLength(2);
});
it("invalidates pending service approval when the administrative target mapping changes", async () => {
  const f = await serviceConfig(),
    m = await mandate(f.target.id, ["docker.container.restart"]);
  const port = await workflowIntegrationPort(repo, directory, scope, orderId, m.id);
  const input = { id: randomUUID(), scope, targetId: f.target.id, toolId: "docker.container.restart", args: {} };
  await expect(port.execute(input)).rejects.toMatchObject({ code: "approval_required" });
  await approve(input.id);
  await saveConfiguration(
    directory,
    configSchema.parse({ ...f.config, serviceTargets: [{ ...f.target, resourceName: "changed-container" }] }),
  );
  const changed = await workflowIntegrationPort(repo, directory, scope, orderId, m.id);
  await expect(changed.execute(input)).rejects.toMatchObject({ code: "action_binding_conflict" });
  await expect(readFile(f.log)).rejects.toMatchObject({ code: "ENOENT" });
});
it("keeps an uncertain native restart unknown and never reruns it blindly", async () => {
  const f = await serviceConfig(true),
    m = await mandate(f.target.id, ["docker.container.restart"]);
  const port = await workflowIntegrationPort(repo, directory, scope, orderId, m.id);
  const input = { id: randomUUID(), scope, targetId: f.target.id, toolId: "docker.container.restart", args: {} };
  await expect(port.execute(input)).rejects.toMatchObject({ code: "approval_required" });
  await approve(input.id);
  await expect(port.execute(input)).rejects.toMatchObject({ effectStatus: "effect_unknown" });
  await expect(port.execute(input)).rejects.toMatchObject({ effectStatus: "effect_unknown" });
  expect(await readFile(f.log, "utf8")).toBe("attempt\n");
});
