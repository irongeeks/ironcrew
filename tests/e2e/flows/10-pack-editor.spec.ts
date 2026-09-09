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

    // The product exposes View/Edit modes and a monitor toggle in View.
    // Missing controls are regressions, never reasons to skip the test.
    const view = page.getByRole("button", { name: "View", exact: true });
    const edit = page.getByRole("button", { name: "Edit", exact: true });
    const monitor = page.getByRole("button", { name: "Live Monitor", exact: true });
    await expect(view).toBeVisible();
    await expect(monitor).toBeVisible();
    await monitor.click();
    await edit.click();
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeVisible();
    await expect(monitor).toBeHidden();
    await view.click();
    await expect(monitor).toBeVisible();
    await expect(page.locator(".react-flow").first()).toBeVisible();
  });

  test("editor mode: create and reopen a community pack", async ({ page, request }) => {
    const csrf = await establishSession(request);
    const headers = { "x-csrf-token": csrf };
    await navigateTo(page, "workflows");
    await page
      .getByRole("button", { name: /graph|dag|flow/i })
      .first()
      .click();
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await page.getByRole("button", { name: "+ New Pack", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Create New Pack", exact: true });
    const packKey = `e2epack_${Date.now()}`;
    try {
      await dialog.getByPlaceholder("e.g. my_workflow", { exact: true }).fill(packKey);
      await dialog.getByPlaceholder("e.g. My Custom Workflow", { exact: true }).fill("E2E stored workflow");
      await dialog.getByRole("button", { name: "Create Pack", exact: true }).click();
      await expect(dialog).toBeHidden();
      const response = await request.get(`/api/ops/workflow-packs/${packKey}/definition`);
      expect(response.ok()).toBe(true);
      const pack = await response.json();
      expect(pack.definition.pack.key).toBe(packKey);
      expect(pack.definition.pack.name.en).toBe("E2E stored workflow");
      await expect(page.locator(".react-flow__node")).toHaveCount(1);
    } finally {
      const response = await request.delete(`/api/ops/workflow-packs/${packKey}`, { headers });
      expect([200, 404]).toContain(response.status());
    }
  });

  test("editor mode: select node and view properties", async ({ page }) => {
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
    await expect(page.getByText("Phase ID", { exact: true })).toBeVisible();
    await expect(page.getByText("Department", { exact: true }).last()).toBeVisible();
  });
});
