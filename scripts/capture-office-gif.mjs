import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const OUT = process.env.OUT || "/tmp/frames";
const URL = process.env.URL || "http://127.0.0.1:8800";
const FRAMES = Number(process.env.FRAMES || 56);
const INTERVAL = Number(process.env.INTERVAL || 110); // ms between frames
const EXPAND = process.env.EXPAND !== "0";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: 1,
});
const page = await ctx.newPage();
await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });

// Wait for the office canvas to exist
await page.waitForSelector("canvas", { timeout: 30000 });

let clip;
if (EXPAND) {
  // Click the "Expand" control to get the fullscreen office, which re-mounts
  // the scene and re-runs the agents' walk-to-seat animation.
  const expand = page.getByText("Expand", { exact: false }).first();
  try {
    await expand.click({ timeout: 4000 });
    await page.waitForTimeout(400);
  } catch {
    console.log("Expand not clickable, capturing embedded canvas");
  }
}

// Resolve the largest canvas bounding box as the capture clip.
const handle = await page.evaluateHandle(() => {
  const cs = [...document.querySelectorAll("canvas")];
  cs.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight);
  return cs[0];
});
const box = await handle.asElement().boundingBox();
clip = {
  x: Math.round(box.x),
  y: Math.round(box.y),
  width: Math.round(box.width),
  height: Math.round(box.height),
};
console.log("CLIP:", JSON.stringify(clip));

const t0 = Date.now();
for (let i = 0; i < FRAMES; i++) {
  const target = t0 + i * INTERVAL;
  const wait = target - Date.now();
  if (wait > 0) await page.waitForTimeout(wait);
  await page.screenshot({
    path: `${OUT}/f${String(i).padStart(3, "0")}.png`,
    clip,
  });
}
console.log(`captured ${FRAMES} frames -> ${OUT}`);
await browser.close();
