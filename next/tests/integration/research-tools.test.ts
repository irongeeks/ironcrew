import { afterEach, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Repository } from "../../packages/persistence/src/index.ts";
import { Runtime } from "../../packages/runtime/src/engine.ts";
import { researchTools } from "../../apps/control/research-tools.ts";
import { ManagedActions } from "../../packages/domain/workflows/actions.ts";
import { sha256 } from "../../packages/domain/src/index.ts";
import { digest } from "../../packages/tools/workspace.ts";
import type { ResearchReport } from "../../packages/domain/workflows/research.ts";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup.length = 0;
});
it("runs source/report/delivery through actual Runtime and HTTP, preserving full source bytes and exact report hashes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ic-research-tools-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const repo = await Repository.open(path.join(directory, "db.sqlite"));
  cleanup.push(() => repo.close());
  const setup = await repo.setup({
    companyName: "Research",
    ceoName: "CEO",
    passwordHash: "fixture",
    timezone: "UTC",
    budgetLimitUsdMicros: "100",
  });
  const scope = { companyId: setup.company.id, areaId: setup.areas[0]!.id };
  let order = await repo.createOrder(scope, {
    kind: "research",
    goal: "Compare verified sources",
    budgetLimitUsdMicros: "100",
  });
  order = await repo.commitPlan(scope, order.id, order.revision, {
    steps: ["Source and deliver"],
    acceptanceCriteria: ["Exact source and external receipt"],
  });
  const targetId = randomUUID(),
    mandate = {
      id: randomUUID(),
      version: 1,
      scope,
      allowedToolIds: ["research.source", "research.report", "research.deliver", "research.fetch", "nextcloud.write"],
      targetIds: [order.id, targetId],
      parameterConstraints: {},
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      maxAttempts: 10,
      maxDurationSeconds: 60,
      maxCostUsdMicros: "100",
    };
  await repo.createMandate(mandate);
  const content = "Actual original source. ".repeat(1500);
  let delivered = "",
    calls = 0;
  const server = createServer(async (req, res) => {
    if (req.method === "GET") return void res.end(content);
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    delivered = Buffer.concat(chunks).toString();
    res.writeHead(201, { etag: '"v1"' }).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const managed = new ManagedActions(repo, path.join(directory, "receipts"));
  const tools = researchTools({
    repo,
    directory,
    port: async (s, oid, mid, mv) => ({
      execute: async (a) => {
        const result = await managed.perform(
          {
            id: a.id,
            scope: s,
            orderId: oid,
            mandateId: mid,
            mandateVersion: mv,
            toolId: a.toolId,
            targetId: a.targetId,
            args: a.args as never,
            effect: a.toolId === "research.fetch" ? "read" : "external_draft",
          },
          async () => {
            calls++;
            const response = await fetch(
              endpoint,
              a.toolId === "research.fetch" ? {} : { method: "PUT", body: (a.args as { content: string }).content },
            );
            return {
              observedAt: new Date().toISOString(),
              effectStatus: "succeeded" as const,
              evidenceRefs: [],
              externalId: endpoint + "/report.md",
              data:
                a.toolId === "research.fetch"
                  ? { content: await response.text() }
                  : { etag: response.headers.get("etag") },
            };
          },
        );
        if (result.state !== "succeeded") throw Error(result.state);
        return result.data as never;
      },
    }),
  });
  let turn = 0,
    report: ResearchReport | undefined;
  const runtime = new Runtime({
    repo,
    directory,
    tools,
    models: [
      { id: "fixture", name: "Fixture", supported_parameters: ["tools"], pricing: { prompt: "0", completion: "0" } },
    ],
    client: {
      complete: async () => {
        const number = turn++;
        let name = "research__source",
          args: unknown = { targetId, url: "https://example.test/source", title: "Actual source" };
        if (number === 1) {
          const sources = await repo.listDocuments(scope, "research-source");
          args = {
            title: "Evidence report",
            recommendation: "Review recommendation",
            reasons: [{ text: "Actual evidence", sourceIds: [sources[0]!.id] }],
            comparison: "Single fixture",
            methodology: "Read source",
            assumptions: [],
            gaps: [],
            requiredDelivery: "nextcloud",
            sourceIds: [sources[0]!.id],
          };
          name = "research__report";
        }
        if (number === 2) {
          report = (await repo.listDocuments<ResearchReport>(scope, "artifact"))[0]!.data;
          args = { artifactVersionId: report.id, expectedSha256: report.sha256, targetId, path: "report.md" };
          name = "research__deliver";
        }
        return {
          id: "fixture-" + number,
          costUsdMicros: "0",
          message:
            number < 3
              ? {
                  role: "assistant" as const,
                  tool_calls: [
                    {
                      id: "call-" + number,
                      type: "function" as const,
                      function: { name, arguments: JSON.stringify(args) },
                    },
                  ],
                }
              : { role: "assistant" as const, content: "Delivered for lead review" },
        };
      },
    },
  });
  const run = await runtime.start(scope, order.id, mandate, "fixture");
  expect(run.messages.some((m) => m.role === "tool" && m.content?.includes('"state":"delivered"'))).toBe(true);
  expect(calls).toBe(2);
  const source = (await repo.listDocuments<{ contentSha256: string; excerpt: string }>(scope, "research-source"))[0]!
    .data;
  expect(source.excerpt.length).toBe(20000);
  expect(await readFile(path.join(directory, "blobs", source.contentSha256), "utf8")).toBe(content);
  expect(digest(delivered)).toBe(report!.sha256);
  for (const t of await repo.listDocuments<{ request: unknown; requestSha256: string }>(scope, "model-turn"))
    expect(sha256(t.data.request)).toBe(t.data.requestSha256);
  const action = (await repo.listDocuments<Record<string, unknown>>(scope, "action")).find(
    (a) => a.data.toolId === "research.report",
  )!;
  await repo.putDocument(
    scope,
    "action",
    action.id,
    { ...action.data, status: "running" },
    { expectedRevision: action.revision },
  );
  const repeated = await tools[1]!.execute(action.data.args, { ...action.data, status: "running" } as never);
  expect((repeated as ResearchReport).id).toBe(report!.id);
  expect(await repo.listDocuments(scope, "artifact")).toHaveLength(1);
  const deliveryAction = (await repo.listDocuments<Record<string, unknown>>(scope, "action")).find(
    (a) => a.data.toolId === "research.deliver",
  )!;
  const staleArgs = { ...(deliveryAction.data.args as Record<string, unknown>), expectedSha256: "0".repeat(64) };
  const stale = {
    ...deliveryAction.data,
    id: randomUUID(),
    args: staleArgs,
    argumentsSha256: sha256(staleArgs),
    status: "running",
  };
  await repo.putDocument(scope, "action", stale.id, stale);
  await expect(tools[2]!.execute(staleArgs, stale as never)).rejects.toThrow("research_artifact_mismatch");
  await expect(
    tools[0]!.execute({}, { ...stale, scope: { ...scope, areaId: randomUUID() } } as never),
  ).rejects.toThrow();
  expect(
    tools[1]!.schema.safeParse({
      ...(action.data.args as Record<string, unknown>),
      sources: [{ id: "invented", excerpt: "Forged source" }],
    }).success,
  ).toBe(false);
  expect(calls).toBe(2);
});
