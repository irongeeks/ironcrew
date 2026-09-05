import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunnerWorkspaceTools } from "./workspace-tools.ts";
import type { RunContext } from "../runtime/run-events.ts";

let root: string;
let context: RunContext;
let tools: RunnerWorkspaceTools;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "runner-tools-"));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "notes.md"), "Projektwissen");
  tools = new RunnerWorkspaceTools(path.join(root, "audit", "tools.ndjson"));
  context = {
    companyId: "company",
    projectId: "project",
    taskId: "task",
    runId: "run",
    agentId: "agent",
    correlationId: "corr",
    workspacePath: project,
    permissionMode: "restricted",
    allowedTools: ["workspace.read", "workspace.list"],
  };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const call = (name: string, relative: string) => ({ id: "tool-call", name, arguments: { path: relative } });

describe("native workspace tool allowlist", () => {
  it("provides real bounded reads and listings with durable attributed audit", async () => {
    const toolCall = call("workspace_read", "notes.md");
    expect((await tools.listTools(context)).map((tool) => tool.name)).toEqual(["workspace_list", "workspace_read"]);
    expect(await tools.authorize(toolCall, context)).toEqual({ status: "allowed" });
    await tools.audit("started", toolCall, context);
    const result = await tools.execute(toolCall, context);
    expect(result).toEqual({ path: "notes.md", text: "Projektwissen", bytes: 13 });
    await tools.audit("completed", toolCall, context, result);
    expect(await tools.execute(call("workspace_list", "."), context)).toMatchObject({
      entries: [{ name: "notes.md", kind: "file" }],
      truncated: false,
    });
    const audit = fs.readFileSync(path.join(root, "audit", "tools.ndjson"), "utf-8");
    const entries = audit
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      actor: "agent",
      companyId: "company",
      taskId: "task",
      runId: "run",
      correlationId: "corr",
      stage: "started",
    });
    expect(audit).not.toContain("Projektwissen");
  });

  it.each(["../outside", "/etc/passwd", ".env", "sub/../../outside", ".ssh/key"])(
    "denies unsafe/private path %s at execution as well as authorization",
    async (relative) => {
      expect((await tools.authorize(call("workspace_read", relative), context)).status).toBe("denied");
      await expect(tools.execute(call("workspace_read", relative), context)).rejects.toThrow(/nicht erlaubt/);
    },
  );

  it("does not expose symlink targets or credentials in directory listings", async () => {
    fs.writeFileSync(path.join(root, "outside"), "private");
    fs.symlinkSync(path.join(root, "outside"), path.join(context.workspacePath, "link"));
    fs.writeFileSync(path.join(context.workspacePath, ".env.local"), "private");
    expect((await tools.authorize(call("workspace_read", "link"), context)).status).toBe("denied");
    expect(await tools.execute(call("workspace_list", "."), context)).toMatchObject({
      entries: [{ name: "notes.md", kind: "file" }],
    });
  });

  it("denies tools without an assigned project and refuses arbitrary tools", async () => {
    expect(await tools.listTools({ ...context, projectId: null })).toEqual([]);
    expect(await tools.listTools({ ...context, allowedTools: undefined })).toEqual([]);
    expect((await tools.authorize(call("workspace_read", "notes.md"), { ...context, allowedTools: [] })).status).toBe(
      "denied",
    );
    expect((await tools.authorize(call("shell", "notes.md"), context)).status).toBe("denied");
  });

  it("rejects oversized and binary files and caps directory enumeration", async () => {
    fs.writeFileSync(path.join(context.workspacePath, "large"), Buffer.alloc(256 * 1024 + 1, 65));
    fs.writeFileSync(path.join(context.workspacePath, "binary"), Buffer.from([0, 1, 2]));
    await expect(tools.execute(call("workspace_read", "large"), context)).rejects.toThrow(/groß/);
    await expect(tools.execute(call("workspace_read", "binary"), context)).rejects.toThrow(/binär/);
    for (let i = 0; i < 502; i++) fs.writeFileSync(path.join(context.workspacePath, `entry-${i}`), "");
    const listing = (await tools.execute(call("workspace_list", "."), context)) as {
      entries: unknown[];
      truncated: boolean;
    };
    expect(listing.entries).toHaveLength(500);
    expect(listing.truncated).toBe(true);
  });

  it("fails closed when the audit destination is a symlink", async () => {
    const target = path.join(root, "target");
    fs.writeFileSync(target, "intact");
    const link = path.join(root, "audit-link");
    fs.symlinkSync(target, link);
    await expect(
      new RunnerWorkspaceTools(link).audit("started", call("workspace_read", "notes.md"), context),
    ).rejects.toThrow();
    expect(fs.readFileSync(target, "utf-8")).toBe("intact");
  });
});
