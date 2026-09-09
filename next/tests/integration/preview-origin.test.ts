import { it, expect } from "vitest";
import request from "supertest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Repository } from "../../packages/persistence/src/index.ts";
import { createApp } from "../../apps/control/app.ts";
import { issueSetupToken } from "../../apps/control/auth.ts";
import { createPreviewApp } from "../../apps/control/preview.ts";
import { WebsiteWorkflow } from "../../packages/domain/workflows/website.ts";

it("serves built and restored website versions at the current preview origin with matching CSP", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ironcrew-preview-origin-"));
  const repo = await Repository.open(path.join(directory, "company.sqlite"));
  try {
    const previewOrigin = "http://127.0.0.1:18876";
    const app = createApp({ repo, directory, publicOrigin: "http://127.0.0.1:8790", previewOrigin });
    const client = request.agent(app);
    const setup = await client
      .post("/api/v1/setup")
      .send({
        token: await issueSetupToken(directory),
        companyName: "Preview test",
        ceoName: "Owner",
        password: "isolated-preview-test-password",
        timezone: "UTC",
      })
      .expect(200);
    const scope = { companyId: setup.body.company.id as string, areaId: setup.body.areas[0].id as string };
    const order = await repo.createOrder(scope, {
      kind: "website",
      goal: "Preview configuration",
      budgetLimitUsdMicros: "0",
    });
    const website = new WebsiteWorkflow(repo, directory);
    await website.create(scope, order.id, "Current installation preview origin");
    const concepts = await website.concepts(scope, order.id, [
      { name: "First", rationale: "First layout", html: "<!doctype html><h1>Verified preview</h1>" },
      { name: "Second", rationale: "Second layout", html: "<!doctype html><h1>Alternative preview</h1>" },
    ]);
    await website.select(scope, order.id, concepts.data.concepts[0]!.id);
    const version = await website.build(scope, order.id);
    const site = await repo.getDocument<Record<string, unknown>>(scope, "website", order.id);
    expect(site!.data.previewUrl).toBe(`/${version.id}/`);
    await request(createPreviewApp(website))
      .get(`/${version.id}/`)
      .expect(200)
      .expect(/Verified preview/);
    for (const restoredUrl of [undefined, `http://127.0.0.1:8792/${version.id}/`]) {
      if (restoredUrl)
        await repo.putDocument(
          scope,
          "website",
          order.id,
          { ...site!.data, previewUrl: restoredUrl },
          { expectedRevision: site!.revision },
        );
      const response = await client.get(`/api/v1/orders/${order.id}/workflow`).expect(200);
      expect(response.body.previewUrl).toBe(`${previewOrigin}/${version.id}/`);
      expect(response.headers["content-security-policy"]).toContain(`frame-src 'self' ${previewOrigin};`);
      expect(response.headers["content-security-policy"]).not.toContain("127.0.0.1:8792");
    }
  } finally {
    await repo.close();
    await rm(directory, { recursive: true, force: true });
  }
});
