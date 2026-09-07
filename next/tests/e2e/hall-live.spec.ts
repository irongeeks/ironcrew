import { test, expect, type Locator } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
async function renderedHall(hall: Locator) {
  await expect(hall).toHaveAttribute("data-crew-assets", "verified");
  const canvas = hall.locator("canvas[data-engine]");
  await expect(canvas).toBeVisible();
  await expect
    .poll(() =>
      canvas.evaluate((element) => {
        const gl = (element as HTMLCanvasElement).getContext("webgl2");
        return !!gl && !gl.isContextLost() && gl.getParameter(gl.CURRENT_PROGRAM) !== null;
      }),
    )
    .toBe(true);
  return canvas;
}
// Real local application and SQLite setup via e2e-server.ts. No API interception.
test("real hall preserves keyboard access, reduced motion, camera and WebGL-loss fallback", async ({ page }) => {
  // Keep evidence capture and navigation static; animation is explicitly enabled and checked below.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/hq");
  await page.getByLabel("Passwort", { exact: true }).fill("local-e2e-fixture-password");
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  const hall = page.getByRole("region", { name: "Räumliche Einsatzzentrale" });
  await renderedHall(hall);
  await expect(hall).toHaveAttribute("data-motion", "reduced");
  await expect(page.getByRole("link", { name: "NF Nick Fury", exact: true })).toBeVisible();
  const camera = hall.getByRole("button", { name: "Kamera wechseln", exact: true });
  await camera.focus();
  await page.keyboard.press("Enter");
  await expect(camera).toBeFocused();
  await page.screenshot({ path: "docs/test-evidence/crew-hall-desktop.png", fullPage: true });
  await expect(hall.getByRole("button", { name: "Bewegung an", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Tab");
  await expect(hall.getByRole("button", { name: "Grafik reduzieren", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(hall).toHaveAttribute("data-motion", "animated");
  await page.keyboard.press("Enter");
  await expect(hall).toHaveAttribute("data-motion", "reduced");
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
  await renderedHall(hall);
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
  // Slow CI renderers must not animate during driver roundtrips and trace capture outside the measured phase.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/hq");
  await page.getByLabel("Passwort", { exact: true }).fill("local-e2e-fixture-password");
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  const hall = page.getByRole("region", { name: "Räumliche Einsatzzentrale" });
  await renderedHall(hall);
  await expect(hall).toHaveAttribute("data-motion", "reduced");
  const motion = hall.getByRole("button", { name: "Bewegung an", exact: true });
  const sample = await motion.evaluate(async (element) => {
    const button = element as HTMLButtonElement;
    const region = button.closest('[role="region"]') as HTMLElement;
    const canvas = region.querySelector("canvas")!;
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
    button.click();
    const animationStartDeadline = performance.now() + 5000;
    while (region.dataset.motion !== "animated") {
      if (performance.now() >= animationStartDeadline) throw new Error("Hall animation did not start for measurement");
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    await wait(2000);
    if (region.dataset.motion !== "animated") throw new Error("Hall animation did not start for measurement");
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
    const animatedDuringSample = region.dataset.motion === "animated";
    // Stop only after recording the complete six-second animated sample, before the driver captures its trace.
    button.click();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    return {
      animatedDuringSample,
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
        scope:
          "9 idle personas, default quality; static setup followed by explicitly enabled animation throughout 2s warmup and 6s measurement, paused afterward; headless Chromium on this device only, not a cross-device guarantee",
        ...sample,
      },
      null,
      2,
    ) + "\n",
  );
  expect(sample.animatedDuringSample).toBe(true);
  await expect(hall).toHaveAttribute("data-motion", "reduced");
  expect(sample.drawCalls).toBeGreaterThan(1000);
  expect(sample.fps).toBeGreaterThanOrEqual(Number(process.env.IRONCREW_PERFORMANCE_MIN_FPS ?? 1));
});
