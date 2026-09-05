import { test, expect } from "@playwright/test";
import { establishSession } from "../fixtures/test-helpers";
import { packGlb } from "../../../server/ironcrew/domain/character-glb.fixture";
import type { Agent, CharacterAppearance, CharacterAsset } from "../../../src/ironcrew/types";

test("private untextured GLB renders interactively while the office retains its 2D fallback", async ({
  page,
  request,
}, testInfo) => {
  const csrf = await establishSession(request);
  const headers = { "x-csrf-token": csrf };
  const { agents } = (await (await request.get("/api/crew/agents")).json()) as { agents: Agent[] };
  const agent = agents.find((item) => item.key === "cto") ?? agents[0];
  const original: CharacterAppearance = {
    character_id: agent.persona.character_id ?? null,
    portrait: agent.persona.portrait,
    full_body: agent.persona.full_body,
    animation_config: agent.persona.animation_config ?? null,
    model_3d: agent.persona.model_3d ?? null,
  };
  let uploaded: CharacterAsset | undefined;
  try {
    await page.setViewportSize({ width: 1440, height: 1080 });
    await page.goto("/");
    await page.getByTestId(`office-person-${agent.id}`).locator(".crew-office-person-button").click();
    await page.getByTestId("edit-agent-character").click();
    const response = page.waitForResponse(
      (result) => result.request().method() === "POST" && result.url().endsWith("/api/crew/character-assets"),
    );
    await page
      .getByLabel("GLB-Modell hochladen", { exact: true })
      .setInputFiles({ name: "model.glb", mimeType: "model/gltf-binary", buffer: packGlb() });
    uploaded = (await (await response).json()).asset;
    const model = page.getByRole("region", { name: "3D-Modellvorschau" });
    await expect(model.getByRole("img", { name: "Interaktive 3D-Figur" })).toBeVisible();
    await page.getByRole("button", { name: "Nach links drehen", exact: true }).click();
    await page.getByRole("button", { name: "Vergrößern", exact: true }).click();
    await model.screenshot({ path: testInfo.outputPath("private-glb-preview.png") });
    await page.getByRole("button", { name: "Figur speichern", exact: true }).click();
    await expect(page.locator(".character-editor")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.reload();
    const person = page.getByTestId(`office-person-${agent.id}`);
    await expect(person.locator("svg[data-character-id]")).toBeVisible();
    await expect(person.locator("canvas")).toHaveCount(0);
    const after = ((await (await request.get("/api/crew/agents")).json()) as { agents: Agent[] }).agents.find(
      (item) => item.id === agent.id,
    )!;
    expect(after.persona.model_3d).toBe(uploaded!.url);
    expect(after.policy).toEqual(agent.policy);
  } finally {
    await request.patch(`/api/crew/agents/${agent.id}/appearance`, { headers, data: original });
    if (uploaded)
      await request.delete(`/api/crew/character-assets/${uploaded.id}`, { headers, data: { detach: true } });
  }
});
