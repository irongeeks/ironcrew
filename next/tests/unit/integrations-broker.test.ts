import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { ServiceBroker, type BrokerRunner } from "../../packages/integrations/src/service-broker.ts";
import type { GitActionPort } from "../../packages/integrations/src/git.ts";
import type { ToolAction } from "../../packages/contracts/src/index.ts";
const scope = { companyId: randomUUID(), areaId: randomUUID() };
const port: GitActionPort = {
  perform: async (request, execute) => ({
    id: request.id!,
    state: "succeeded",
    data: await execute({ id: request.id! } as ToolAction),
  }),
};
const request = () => ({ id: randomUUID(), orderId: randomUUID(), mandateId: randomUUID(), mandateVersion: 1 });
describe("typed native service broker command contracts", () => {
  it("restricts Linux restart to an exact target and requires independent functional evidence", async () => {
    let argv: string[] = [];
    const run: BrokerRunner = async (_file, args, options) => {
      argv = args;
      expect(options.env).not.toHaveProperty("HOME");
      return { stdout: "", exitCode: 0 };
    };
    const result = await new ServiceBroker(
      {
        id: randomUUID(),
        scope,
        kind: "systemd",
        resourceName: "ironcrew-fixture.service",
        executable: "/usr/bin/systemctl",
      },
      port,
      run,
    ).execute(request(), "restart");
    expect(argv).toEqual(["restart", "--", "ironcrew-fixture.service"]);
    expect(result.data).toMatchObject({ effectStatus: "accepted", requiresFunctionalCheck: true });
  });
  it("parses actual systemd state field contract instead of inferring health from exit code", async () => {
    const broker = new ServiceBroker(
      { id: randomUUID(), scope, kind: "systemd", resourceName: "fixture.service", executable: "/usr/bin/systemctl" },
      port,
      async () => ({ stdout: "LoadState=loaded\nActiveState=failed\nSubState=failed\n", exitCode: 0 }),
    );
    const result = await broker.execute(request(), "status");
    expect(result.data).toMatchObject({ status: "failed" });
  });
  it("uses Docker container inspect as argv without a shell", async () => {
    let argv: string[] = [];
    const broker = new ServiceBroker(
      {
        id: randomUUID(),
        scope,
        kind: "docker",
        resourceName: "fixture-container",
        executable: "/usr/local/bin/docker",
      },
      port,
      async (_file, args) => {
        argv = args;
        return { stdout: '{"Status":"running","Running":true,"ExitCode":0}', exitCode: 0 };
      },
    );
    expect((await broker.execute(request(), "status")).data).toMatchObject({ status: "running" });
    expect(argv).toEqual(["container", "inspect", "--format", "{{json .State}}", "fixture-container"]);
  });
  it("constructs fixed encoded PowerShell and blocks wildcard/injection target names", async () => {
    let script = "";
    const broker = new ServiceBroker(
      { id: randomUUID(), scope, kind: "windows", resourceName: "Spooler", executable: "/configured/powershell.exe" },
      port,
      async (_file, args) => {
        script = Buffer.from(args.at(-1)!, "base64").toString("utf16le");
        return { stdout: '{"Name":"Spooler","Status":"Running"}', exitCode: 0 };
      },
    );
    expect((await broker.execute(request(), "status")).data).toMatchObject({ status: "Running" });
    expect(script).toContain("Get-Service -Name 'Spooler'");
    expect(
      () =>
        new ServiceBroker(
          {
            id: randomUUID(),
            scope,
            kind: "windows",
            resourceName: "Spooler'; Invoke-Expression x",
            executable: "/configured/powershell.exe",
          },
          port,
        ),
    ).toThrow();
  });
  it("keeps interrupted restart effect unknown and malformed read response failed", async () => {
    const target = {
      id: randomUUID(),
      scope,
      kind: "docker" as const,
      resourceName: "fixture",
      executable: "/usr/local/bin/docker",
    };
    await expect(
      new ServiceBroker(target, port, async () => {
        throw new Error("private stderr");
      }).execute(request(), "restart"),
    ).rejects.toMatchObject({ effectStatus: "effect_unknown" });
    await expect(
      new ServiceBroker(target, port, async () => ({ stdout: "not json", exitCode: 0 })).execute(request(), "status"),
    ).rejects.toMatchObject({ effectStatus: "failed" });
  });
  it("does not execute while the action port waits for approval", async () => {
    let executions = 0;
    const approvals: GitActionPort = { perform: async (request) => ({ id: request.id!, state: "approval" }) };
    const result = await new ServiceBroker(
      { id: randomUUID(), scope, kind: "docker", resourceName: "fixture", executable: "/usr/local/bin/docker" },
      approvals,
      async () => {
        executions++;
        return { stdout: "", exitCode: 0 };
      },
    ).execute(request(), "restart");
    expect(result.state).toBe("approval");
    expect(executions).toBe(0);
  });
});
