import { test, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
// Real local application and SQLite setup via e2e-server.ts. No API interception.
test("real hall preserves keyboard access, reduced motion, camera and WebGL-loss fallback", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/hq");
  await page.getByLabel("Passwort", { exact: true }).fill("local-e2e-fixture-password");
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  const hall = page.getByRole("region", { name: "Räumliche Einsatzzentrale" });
  await expect(hall).toHaveAttribute("data-crew-assets", "verified");
  await expect(hall.locator("canvas")).toBeVisible();
  await expect(page.getByRole("link", { name: "NF Nick Fury", exact: true })).toBeVisible();
  const camera = hall.getByRole("button", { name: "Kamera wechseln", exact: true });
  await camera.focus();
  await page.keyboard.press("Enter");
  await expect(camera).toBeFocused();
  await page.screenshot({ path: "docs/test-evidence/crew-hall-desktop.png", fullPage: true });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(hall).toHaveAttribute("data-motion", "reduced");
  await expect(hall.getByRole("button", { name: "Bewegung an", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Tab");
  await expect(hall.getByRole("button", { name: "Grafik reduzieren", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(hall).toHaveAttribute("data-motion", "animated");
  await page.getByRole("link", { name: "NF Nick Fury", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/crew\//);
  await expect(page.getByRole("img", { name: /Nick Fury/ })).toBeVisible();
  await page.screenshot({ path: "docs/test-evidence/crew-profile-fury.png", fullPage: true });
  await page.goBack();
  await expect(hall).toBeVisible();
  // CDP page scale is browser zoom, not a change to application font rules.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 2 });
  await expect(camera).toBeVisible();
  await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
  await page.setViewportSize({ width: 360, height: 800 });
  await page.reload();
  await expect(page.getByRole("button", { name: "3D", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "docs/test-evidence/crew-hall-mobile-compact.png", fullPage: true });
  await page.getByRole("button", { name: "3D", exact: true }).click();
  await expect(hall).toHaveAttribute("data-crew-assets", "verified");
  await expect(hall.locator("canvas")).toBeVisible();
  await page.evaluate(() => {
    (document.activeElement as HTMLElement)?.blur();
    scrollTo(0, 0);
  });
  await page.screenshot({ path: "docs/test-evidence/crew-hall-mobile-3d.png", fullPage: true });
  await hall.locator("canvas").evaluate((canvas) => {
    const gl = (canvas as HTMLCanvasElement).getContext("webgl2");
    if (!gl) throw new Error("real WebGL2 context missing");
    const extension = gl.getExtension("WEBGL_lose_context");
    if (!extension) throw new Error("WebGL loss extension unavailable");
    extension.loseContext();
  });
  await expect(hall.getByRole("status")).toContainText("Kompakte Ansicht bleibt verfügbar");
  await expect(page.getByRole("link", { name: "NF Nick Fury", exact: true })).toBeVisible();
});

test("measure actual WebGL hall frame rate on the named local browser and device", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/hq");
  await page.getByLabel("Passwort", { exact: true }).fill("local-e2e-fixture-password");
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  const hall = page.getByRole("region", { name: "Räumliche Einsatzzentrale" });
  await expect(hall).toHaveAttribute("data-crew-assets", "verified");
  await expect(hall.locator("canvas")).toBeVisible();
  const sample = await page.evaluate(async () => {
    const canvas = document.querySelector("canvas")!;
    const gl = canvas.getContext("webgl2")!;
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    const frameTimes: number[] = [];
    // Counts actual GL draws, not just requestAnimationFrame callbacks. Reset after 2s shader warmup.
    let draws = 0;
    const original = gl.drawElements.bind(gl);
    gl.drawElements = (...args) => {
      draws++;
      return original(...args);
    };
    const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    await wait(2000);
    draws = 0;
    let renderedFrames = 0,
      previousDraws = 0;
    const started = performance.now();
    let previous: number | undefined;
    await new Promise<void>((resolve) => {
      const frame = (now: number) => {
        if (draws > previousDraws) {
          renderedFrames++;
          if (previous !== undefined) frameTimes.push(now - previous);
        }
        previousDraws = draws;
        previous = now;
        if (now - started < 6000) requestAnimationFrame(frame);
        else resolve();
      };
      requestAnimationFrame(frame);
    });
    const durationMs = performance.now() - started;
    gl.drawElements = original;
    return {
      renderedFrames,
      durationMs,
      fps: renderedFrames / (durationMs / 1000),
      drawCalls: draws,
      frameTimesMs: frameTimes,
      renderer: debug
        ? (gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) as string)
        : (gl.getParameter(gl.RENDERER) as string),
      browser: navigator.userAgent,
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    };
  });
  await mkdir("docs/test-evidence", { recursive: true });
  await writeFile(
    "docs/test-evidence/crew-hall-performance.json",
    JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        source: "actual WebGL drawElements calls during real local application rendering",
        device: { platform: os.platform(), release: os.release(), arch: os.arch(), cpu: os.cpus()[0]?.model },
        scope: "9 idle personas, default quality, headless Chromium on this device only; not a cross-device guarantee",
        ...sample,
      },
      null,
      2,
    ) + "\n",
  );
  expect(sample.drawCalls).toBeGreaterThan(1000);
  expect(sample.fps).toBeGreaterThanOrEqual(Number(process.env.IRONCREW_PERFORMANCE_MIN_FPS ?? 1));
});
