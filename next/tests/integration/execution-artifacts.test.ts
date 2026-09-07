import { it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Repository } from "../../packages/persistence/src/index.ts";
import { Runtime } from "../../packages/runtime/src/engine.ts";
import { digest } from "../../packages/tools/workspace.ts";
import type { ToolAction } from "../../packages/contracts/src/index.ts";
it("stages binary execution output only from a successful same-order receipt and rejects later tampering", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "execution-artifact-")),
    repo = await Repository.open(path.join(directory, "company.sqlite"));
  try {
    const setup = await repo.setup({
      companyName: "Artifact fixture",
      ceoName: "CEO",
      passwordHash: "fixture",
      timezone: "UTC",
      budgetLimitUsdMicros: "0",
    });
    const scope = { companyId: setup.company.id, areaId: setup.areas[0]!.id },
      order = await repo.createOrder(scope, { kind: "website", goal: "Output fixture", budgetLimitUsdMicros: "0" });
    const runtime = new Runtime({
      repo,
      directory,
      models: [],
      client: {
        complete: async () => {
          throw new Error("No model call expected");
        },
      },
    });
    const tools = await runtime.localTools(order.id, scope),
      stage = tools.find((t) => t.id === "artifact.stage")!,
      execute = tools.find((t) => t.id === "workspace.execute")!;
    expect(
      execute.schema.safeParse({ argv: ["node", "build.mjs"], purpose: "build", outputPaths: ["dist"] }).success,
    ).toBe(true);
    const outputDirectory = path.join(directory, "isolated-export"),
      relative = "image.png",
      content = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 0, 200]);
    await mkdir(outputDirectory);
    await writeFile(path.join(outputDirectory, relative), content);
    const action: ToolAction = {
      id: randomUUID(),
      runId: order.id,
      orderId: order.id,
      scope,
      toolId: "workspace.execute",
      toolVersion: 1,
      args: { argv: ["node", "build.mjs"] },
      argumentsSha256: "0".repeat(64),
      status: "succeeded",
      mandateId: randomUUID(),
      mandateVersion: 1,
      evidenceRefs: [],
    };
    // An explicitly seeded receipt tests the artifact boundary; Linux execution is tested separately in the VM lab.
    await repo.putDocument(scope, "action", action.id, {
      ...action,
      result: { exitCode: 0, termination: "exited", outputDirectory, outputHashes: { [relative]: digest(content) } },
    });
    const staged = (await stage.execute(
      { path: relative, mediaType: "image/png", executionActionId: action.id },
      { ...action, id: randomUUID(), toolId: "artifact.stage" },
    )) as { sha256: string; bytes: number };
    expect(staged.bytes).toBe(content.length);
    expect(await readFile(path.join(directory, "blobs", staged.sha256))).toEqual(content);
    await expect(
      stage.execute(
        { path: "../company.sqlite", mediaType: "application/octet-stream", executionActionId: action.id },
        { ...action, id: randomUUID() },
      ),
    ).rejects.toMatchObject({ code: "execution_output_not_found" });
    const other = await repo.createOrder(scope, { kind: "website", goal: "Other", budgetLimitUsdMicros: "0" }),
      otherTools = await runtime.localTools(other.id, scope);
    await expect(
      otherTools
        .find((t) => t.id === "artifact.stage")!
        .execute(
          { path: relative, mediaType: "image/png", executionActionId: action.id },
          { ...action, id: randomUUID(), orderId: other.id },
        ),
    ).rejects.toMatchObject({ code: "execution_output_unavailable" });
    await writeFile(path.join(outputDirectory, relative), "changed");
    await expect(
      stage.execute(
        { path: relative, mediaType: "image/png", executionActionId: action.id },
        { ...action, id: randomUUID() },
      ),
    ).rejects.toMatchObject({ code: "execution_output_changed" });
    // New execution receipts bind company-owned blob bytes, so remote temporary paths may disappear.
    const receipt = await repo.getDocument(scope, "action", action.id);
    await repo.putDocument(
      scope,
      "action",
      action.id,
      {
        ...action,
        result: {
          exitCode: 0,
          termination: "exited",
          outputDirectory,
          outputStorage: "content-addressed",
          outputHashes: { [relative]: digest(content) },
        },
      },
      { expectedRevision: receipt!.revision },
    );
    await rm(outputDirectory, { recursive: true });
    const fromBlob = await stage.execute(
      { path: relative, mediaType: "image/png", executionActionId: action.id },
      { ...action, id: randomUUID(), toolId: "artifact.stage" },
    );
    expect(fromBlob).toMatchObject({ sha256: digest(content), bytes: content.length });
    await writeFile(path.join(directory, "blobs", digest(content)), "tampered blob");
    await expect(
      stage.execute(
        { path: relative, mediaType: "image/png", executionActionId: action.id },
        { ...action, id: randomUUID(), toolId: "artifact.stage" },
      ),
    ).rejects.toMatchObject({ code: "execution_output_changed" });
  } finally {
    await repo.close();
    await rm(directory, { recursive: true, force: true });
  }
});
