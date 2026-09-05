import { test, expect } from "@playwright/test";
import sharp from "sharp";
import { establishSession } from "../fixtures/test-helpers";
import type { Agent } from "../../../src/ironcrew/types";

test.describe("Employee character profiles", () => {
  test("assigns one of 20 presets, persists after reload and leaves professional policy unchanged", async ({
    page,
    request,
  }, testInfo) => {
    const csrf = await establishSession(request);
    const { agents } = (await (await request.get("/api/crew/agents")).json()) as { agents: Agent[] };
    const agent = agents.find((a) => a.key === "cto") ?? agents[0];
    const before = {
      character_id: agent.persona.character_id ?? null,
      portrait: agent.persona.portrait,
      full_body: agent.persona.full_body,
    };
    try {
      await page.setViewportSize({ width: 1440, height: 1080 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto("/");
      await page.locator(".ic-agent").filter({ hasText: agent.displayName }).click();
      await page.getByTestId("edit-agent-character").click();
      const gallery = page.getByRole("group", { name: "Vordefinierte Charaktere" });
      await expect(gallery.getByRole("button")).toHaveCount(20);
      await gallery.screenshot({ path: testInfo.outputPath("character-presets-20.png") });
      await gallery.getByRole("button", { name: /^Kristallwesen:/ }).click();
      await expect(page.getByRole("img", { name: "Vorschau der Bürofigur" })).toHaveAttribute(
        "data-character-id",
        "crystalline",
      );
      await page.getByRole("button", { name: "Figur speichern", exact: true }).click();
      await expect(page.locator(".character-editor")).toHaveCount(0);
      await page.keyboard.press("Escape");
      await page.reload();
      await expect(page.getByTestId(`office-person-${agent.id}`).locator("svg[data-character-id]")).toHaveAttribute(
        "data-character-id",
        "crystalline",
      );
      const after = ((await (await request.get("/api/crew/agents")).json()) as { agents: Agent[] }).agents.find(
        (a) => a.id === agent.id,
      )!;
      expect(after.professionalRole).toBe(agent.professionalRole);
      expect(after.policy).toEqual(agent.policy);
      expect(after.persona.character_id).toBe("crystalline");
    } finally {
      await request.patch(`/api/crew/agents/${agent.id}/appearance`, {
        headers: { "x-csrf-token": csrf },
        data: before,
      });
    }
  });

  test("uploads a private character, previews it, and retains requested identity in the generator prompt", async ({
    page,
    request,
  }, testInfo) => {
    const csrf = await establishSession(request);
    const { agents } = (await (await request.get("/api/crew/agents")).json()) as { agents: Agent[] };
    const agent = agents.find((a) => a.key === "ea") ?? agents[0];
    const before = {
      character_id: agent.persona.character_id ?? null,
      portrait: agent.persona.portrait,
      full_body: agent.persona.full_body,
    };
    try {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto("/");
      // The mobile office is still the canonical employee entry.
      await page.getByTestId(`office-person-${agent.id}`).locator(".crew-office-person-button").click();
      await page.getByTestId("edit-agent-character").click();
      await page.getByText("Prompt für eine eigene Figur erstellen", { exact: true }).click();
      await page
        .getByLabel("Gewünschte Figur oder Referenz", { exact: true })
        .fill("Pamela Anderson oder Captain America; als Alternative ein Alien mit vier Armen");
      await expect(page.getByLabel("Generator-Prompt", { exact: true })).toHaveValue(
        /Pamela Anderson oder Captain America/,
      );
      const image = await sharp(
        Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="96"><circle cx="32" cy="16" r="12" fill="#c7a486"/><path d="M20 32h24v35H20zM20 67h9v23h-9m15-23h9v23h-9" fill="#638b92"/></svg>',
        ),
      )
        .png()
        .toBuffer();
      await page
        .getByLabel("Ganzkörperbild für das Büro", { exact: true })
        .setInputFiles({ name: "private-character.png", mimeType: "image/png", buffer: image });
      const preview = page.getByRole("img", { name: "Vorschau der Bürofigur" });
      await expect(preview).toHaveAttribute("data-character-source", "upload");
      await expect(page.locator(".character-editor-notice")).toContainText("Vorschau prüfen");
      await page
        .locator(".character-editor-preview-row")
        .screenshot({ path: testInfo.outputPath("character-upload-preview-mobile.png") });
      await page.getByRole("button", { name: "Figur speichern", exact: true }).click();
      await expect(page.locator(".character-editor")).toHaveCount(0);
      await page.keyboard.press("Escape");
      await page.reload();
      const figure = page.getByTestId(`office-person-${agent.id}`).locator("svg[data-character-id]");
      await expect(figure).toHaveAttribute("data-character-source", "upload");
      const saved = ((await (await request.get("/api/crew/agents")).json()) as { agents: Agent[] }).agents.find(
        (a) => a.id === agent.id,
      )!;
      expect(saved.persona.full_body).toMatch(/^\/api\/crew\/character-assets\//);
      const asset = await request.get(saved.persona.full_body!);
      expect(asset.ok()).toBeTruthy();
      expect(asset.headers()["content-type"]).toContain("image/webp");
      expect(saved.policy).toEqual(agent.policy);
    } finally {
      await request.patch(`/api/crew/agents/${agent.id}/appearance`, {
        headers: { "x-csrf-token": csrf },
        data: before,
      });
    }
  });
});
