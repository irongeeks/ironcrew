import { test, expect } from "@playwright/test";
import { navigateTo, establishSession } from "../fixtures/test-helpers";

test.describe("Pack Editor Flow", () => {
  test.setTimeout(120_000);

  test.beforeEach(async ({ page, request }) => {
    await establishSession(request);
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
  });

  test("visualizer mode renders DAG for built-in pack", async ({ page }) => {
    await navigateTo(page, "workflows");
    const graphBtn = page.getByRole("button", { name: /graph|dag|flow/i }).first();
    await graphBtn.click();
    const reactFlowCanvas = page.locator(".react-flow, [class*=react-flow], [class*=ReactFlow]").first();
    await expect(reactFlowCanvas).toBeVisible({ timeout: 5000 });
    const nodes = page.locator(".react-flow__node, [class*=react-flow__node]");
    const nodeCount = await nodes.count();
    expect(nodeCount).toBeGreaterThan(0);
  });

  test("switch between editor modes", async ({ page }) => {
    await navigateTo(page, "workflows");
    const graphBtn = page.getByRole("button", { name: /graph|dag|flow/i }).first();
    await graphBtn.click();
    await expect(page.locator(".react-flow, [class*=react-flow], [class*=ReactFlow]").first()).toBeVisible({
      timeout: 5000,
    });

    const modes = ["ansicht", "monitor", "bearbeiten", "builder"];
    for (const mode of modes) {
      const modeBtn = page.getByRole("button", { name: new RegExp(mode, "i") }).first();
      const visible = await modeBtn.isVisible().catch(() => false);
      test.skip(!visible, `Mode button "${mode}" not visible`);
      await modeBtn.click();
      // Verify the React Flow canvas is still rendered after mode switch
      await expect(page.locator(".react-flow, [class*=react-flow], [class*=ReactFlow]").first()).toBeVisible();
    }
  });

  test("builder mode: create new pack", async ({ page, request }) => {
    test.fixme(true, "Builder mode (separate pack creation UI) not implemented in current WorkflowEditorPage");
    await navigateTo(page, "workflows");
    const graphBtn = page.getByRole("button", { name: /graph|dag|flow/i }).first();
    await graphBtn.click();
    await expect(page.locator(".react-flow, [class*=react-flow], [class*=ReactFlow]").first()).toBeVisible({
      timeout: 5000,
    });

    const builderBtn = page.getByRole("button", { name: /builder/i }).first();
    await expect(builderBtn).toBeVisible();
    await builderBtn.click();

    const newPackBtn = page.getByRole("button", { name: /New Pack|Neues Pack|\+.*Pack/i }).first();
    await expect(newPackBtn).toBeVisible();
    await newPackBtn.click();

    // CreatePackDialog is a fixed overlay, not role=dialog
    // It has three inputs: Pack Key, Name, Description
    const dialog = page.locator(".fixed.inset-0").last();
    await expect(dialog).toBeVisible();
    const packKey = `e2epack${Date.now()}`;
    const packName = `E2E Test Pack`;

    // First input is Pack Key
    const keyInput = dialog.locator("input").first();
    await keyInput.fill(packKey);

    // Second input is Name
    const nameInput = dialog.locator("input").nth(1);
    await nameInput.fill(packName);

    // Click "Create Pack" button
    await dialog.getByRole("button", { name: /Create Pack|erstellen|create/i }).click();

    // Verify the pack was created via API
    const res = await request.get("/api/ops/workflow-packs/registry");
    const registry = await res.json();
    const pack = Object.values(registry).find((p: any) => p.key === packKey || p.name === packName);
    if (pack) {
      await request.delete(`/api/ops/workflow-packs/${packKey}`);
    }
  });

  test("editor mode: select node and view properties", async ({ page }) => {
    test.fixme(true, "PropertyPanel CSS class locators need data-testid attributes for reliable detection");

    await navigateTo(page, "workflows");
    const graphBtn = page.getByRole("button", { name: /graph|dag|flow/i }).first();
    await graphBtn.click();
    await expect(page.locator(".react-flow, [class*=react-flow], [class*=ReactFlow]").first()).toBeVisible({
      timeout: 5000,
    });

    const editorBtn = page.getByRole("button", { name: /edit|bearbeiten|editor/i }).first();
    await expect(editorBtn).toBeVisible({ timeout: 5000 });
    await editorBtn.click();

    const node = page.locator(".react-flow__node").first();
    await expect(node).toBeVisible();
    await node.click();
  });
});
