import { afterEach, beforeEach, expect, it, vi } from "vitest";
import request from "supertest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Repository } from "../../packages/persistence/src/index.ts";
import { createApp } from "../../apps/control/app.ts";
import { issueSetupToken } from "../../apps/control/auth.ts";
import { configSchema } from "../../apps/control/configuration.ts";
import { ProtonPassResolver } from "../../packages/integrations/src/secrets.ts";
import { IntegrationError } from "../../packages/integrations/src/transport.ts";

let directory: string, repo: Repository, agent: ReturnType<typeof request.agent>, csrf: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "ironcrew-readiness-"));
  repo = await Repository.open(path.join(directory, "company.sqlite"));
  agent = request.agent(createApp({ repo, directory, publicOrigin: "http://127.0.0.1:8790" }));
  const setup = await agent
    .post("/api/v1/setup")
    .send({
      token: await issueSetupToken(directory),
      companyName: "Readiness fixture",
      ceoName: "CEO",
      password: "fixture-password-1234",
      timezone: "UTC",
    })
    .expect(200);
  csrf = setup.body.csrfToken;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await repo.close();
  await rm(directory, { recursive: true, force: true });
});
const configuration = () =>
  configSchema.parse({
    liveExecutionEnabled: true,
    proton: { executable: path.resolve("fixture-pass-cli") },
    openrouter: { secretRef: { provider: "proton-pass", shareId: "share", itemId: "item", field: "password" } },
  });
const save = (body: object) =>
  agent.put("/api/v1/configuration").set({ "X-CSRF-Token": csrf, "Idempotency-Key": randomUUID() }).send(body);

it("checks the secret before claiming readiness and never persists its value", async () => {
  const resolve = vi.spyOn(ProtonPassResolver.prototype, "resolve").mockResolvedValue("fixture-never-persist-secret");
  const response = await save(configuration()).expect(200);
  expect(response.body).toMatchObject({ saved: true, runtimeReady: true });
  expect(resolve).toHaveBeenCalledWith(configuration().openrouter!.secretRef, "IronCrew model access readiness check");
  expect(await readFile(path.join(directory, "configuration.json"), "utf8")).not.toContain(
    "fixture-never-persist-secret",
  );
});

it.each(["configuration", "auth"] as const)(
  "rejects an unusable resolver (%s) without replacing a working configuration",
  async (code) => {
    const resolve = vi.spyOn(ProtonPassResolver.prototype, "resolve").mockResolvedValue("fixture-secret");
    await save(configuration()).expect(200);
    const prior = await readFile(path.join(directory, "configuration.json"), "utf8");
    resolve.mockRejectedValue(new IntegrationError(code, "DO-NOT-EXPOSE-SECRET"));
    const changed = configuration();
    changed.openrouter!.secretRef.itemId = "broken-item";
    const response = await save(changed).expect(422);
    expect(response.body.code).toBe(
      code === "configuration" ? "model_secret_configuration" : "model_secret_unavailable",
    );
    expect(JSON.stringify(response.body)).not.toContain("DO-NOT-EXPOSE");
    expect(await readFile(path.join(directory, "configuration.json"), "utf8")).toBe(prior);
    // Failure must release the runtime-update lock and restore the previous runtime.
    resolve.mockResolvedValue("fixture-secret");
    await save(configuration()).expect(200);
  },
);

it("rejects relative CLI paths with a configuration error and allows disabling a broken access", async () => {
  const resolve = vi.spyOn(ProtonPassResolver.prototype, "resolve").mockRejectedValue(new Error("unavailable"));
  const config = configuration();
  config.proton!.executable = "pass-cli";
  expect((await save(config).expect(422)).body.code).toBe("model_secret_configuration");
  config.liveExecutionEnabled = false;
  expect((await save(config).expect(200)).body.runtimeReady).toBe(false);
  expect(resolve).not.toHaveBeenCalled();
});
