import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID, createHash } from "node:crypto";
import { GitConnector, type GitActionPort, type GitConnection } from "../../packages/integrations/src/git.ts";
import { Repository } from "../../packages/persistence/src/index.ts";
import { ManagedActions } from "../../packages/domain/workflows/actions.ts";
import type { ToolAction, ApprovalBinding } from "../../packages/contracts/src/index.ts";
const exec = promisify(execFile);
const directories: string[] = [];
const repositories: Repository[] = [];
async function fixture() {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "ironcrew-git-fixture-")));
  directories.push(directory);
  const source = path.join(directory, "source");
  const remote = path.join(directory, "remote.git");
  await mkdir(source);
  await exec("/usr/bin/git", ["init", "--initial-branch=main", source]);
  await exec("/usr/bin/git", ["init", "--bare", "--initial-branch=main", remote]);
  const git = (args: string[]) =>
    exec("/usr/bin/git", ["-c", "user.name=Fixture Author", "-c", "user.email=fixture@example.org", ...args], {
      cwd: source,
    });
  await writeFile(path.join(source, "README.md"), "seed\n");
  await git(["add", "README.md"]);
  await git(["commit", "-m", "Initial fixture"]);
  await git(["remote", "add", "origin", remote]);
  const initial = (await git(["rev-parse", "HEAD"])).stdout.trim();
  const repo = await Repository.open(path.join(directory, "company.sqlite"));
  repositories.push(repo);
  const setup = await repo.setup({
    companyName: "Git fixture",
    ceoName: "Fixture CEO",
    passwordHash: "fixture",
    timezone: "Europe/Berlin",
    budgetLimitUsdMicros: "0",
  });
  const scope = { companyId: setup.company.id, areaId: setup.areas[0].id };
  const order = await repo.createOrder(scope, {
    kind: "research",
    goal: "Stage and deliver source",
    budgetLimitUsdMicros: "0",
  });
  const targetId = randomUUID();
  const mandate = {
    id: randomUUID(),
    version: 1,
    scope,
    allowedToolIds: ["git.stage", "git.push"],
    targetIds: [targetId],
    parameterConstraints: {},
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    maxAttempts: 2,
    maxDurationSeconds: 60,
    maxCostUsdMicros: "0",
  };
  await repo.createMandate(mandate);
  const config: GitConnection = {
    id: targetId,
    scope,
    repositoryPath: source,
    workspaceRoot: path.join(directory, "worktrees"),
    gitExecutable: "/usr/bin/git",
    sourceBranch: "main",
    remoteName: "origin",
    remoteUrl: remote,
    remoteBranch: "main",
    authorName: "Fixture Author",
    authorEmail: "fixture@example.org",
    allowLocalRemote: true,
  };
  const actions = new ManagedActions(repo, path.join(directory, "receipts"));
  const connector = new GitConnector(config, actions);
  return {
    directory,
    repo,
    connector,
    config,
    initial,
    git,
    scope,
    actions,
    request: { id: randomUUID(), orderId: order.id, mandateId: mandate.id, mandateVersion: 1 },
  };
}
afterEach(async () => {
  for (const repo of repositories.splice(0)) await repo.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
describe("Git connector with local bare remotes and real ManagedActions", () => {
  it("rejects local remote rewrites and nested repository paths", async () => {
    const f = await fixture();
    await f.git(["config", "url.https://unexpected.invalid/.insteadOf", "https://expected.invalid/"]);
    await expect(f.connector.version()).rejects.toMatchObject({ code: "configuration" });
    await f.git(["config", "--remove-section", "url.https://unexpected.invalid/"]);
    const nested = path.join(f.config.repositoryPath, "nested");
    await mkdir(nested);
    const connector = new GitConnector({ ...f.config, repositoryPath: nested }, f.actions);
    await expect(connector.version()).rejects.toMatchObject({ code: "configuration" });
  });
  it("stages an immutable commit in isolated worktree and requires concrete approval before push", async () => {
    const f = await fixture();
    const staged = await f.connector.stage(f.request, {
      expectedHead: f.initial,
      message: "Create report",
      changes: [{ path: "report.md", content: "evidence-backed report", expectedSha256: null }],
    });
    expect(staged.state).toBe("succeeded");
    const data = staged.data as { commit: string; workspace: string };
    expect(data.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(await readFile(path.join(data.workspace, "report.md"), "utf8")).toBe("evidence-backed report");
    expect((await f.git(["rev-parse", "main"])).stdout.trim()).toBe(f.initial);
    const pushRequest = { ...f.request, id: randomUUID() };
    const pending = await f.connector.push(pushRequest, { commit: data.commit, expectedRemoteHead: null });
    expect(pending.state).toBe("approval");
    expect((await f.git(["ls-remote", "--heads", "origin", "refs/heads/main"])).stdout).toBe("");
    const approvalRequest = await f.repo.getDocument<{ binding: ApprovalBinding }>(
      f.scope,
      "approval-request",
      pending.id,
    );
    const approval = await f.repo.approve(f.scope, approvalRequest!.data.binding);
    const action = await f.repo.getDocument<ToolAction>(f.scope, "action", pending.id);
    await f.repo.putDocument(
      f.scope,
      "action",
      pending.id,
      { ...action!.data, approvalId: approval.id, status: "authorized" },
      { expectedRevision: action!.revision },
    );
    const delivered = await f.connector.push(pushRequest, { commit: data.commit, expectedRemoteHead: null });
    expect(delivered.state).toBe("succeeded");
    expect((await f.git(["ls-remote", "--heads", "origin", "refs/heads/main"])).stdout).toContain(data.commit);
    const again = await f.connector.push(pushRequest, { commit: data.commit, expectedRemoteHead: null });
    expect(again).toEqual(delivered);
  });
  it("fails stale file hashes without altering source repository files", async () => {
    const f = await fixture();
    const result = await f.connector.stage(f.request, {
      expectedHead: f.initial,
      message: "Bad patch",
      changes: [{ path: "README.md", content: "bad overwrite", expectedSha256: "0".repeat(64) }],
    });
    expect(result.state).toBe("failed");
    expect(await readFile(path.join(f.config.repositoryPath, "README.md"), "utf8")).toBe("seed\n");
  });
  it("rejects traversal before ManagedActions receives a request", async () => {
    const f = await fixture();
    await expect(
      f.connector.stage(f.request, {
        expectedHead: f.initial,
        message: "Bad path",
        changes: [{ path: "../outside", content: "x", expectedSha256: null }],
      }),
    ).rejects.toThrow();
    await expect(
      f.connector.stage(f.request, {
        expectedHead: f.initial,
        message: "Git metadata",
        changes: [{ path: ".git/config", content: "x", expectedSha256: null }],
      }),
    ).rejects.toThrow();
  });
  it("uses expected revision before any remote push and does not overwrite a moved target", async () => {
    const f = await fixture();
    await f.git(["push", "origin", "main"]);
    const stage = await f.connector.stage(f.request, {
      expectedHead: f.initial,
      message: "Update report",
      changes: [
        {
          path: "README.md",
          content: "new report\n",
          expectedSha256: createHash("sha256").update("seed\n").digest("hex"),
        },
      ],
    });
    const commit = (stage.data as { commit: string }).commit;
    const direct: GitActionPort = {
      perform: async (request, execute) => {
        return { state: "succeeded", id: request.id!, data: await execute({ id: request.id! } as ToolAction) };
      },
    };
    const connector = new GitConnector(f.config, direct);
    await expect(
      connector.push({ ...f.request, id: randomUUID() }, { commit, expectedRemoteHead: null }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect((await f.git(["ls-remote", "--heads", "origin", "refs/heads/main"])).stdout).toContain(f.initial);
  });
});
