import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const OUT = process.env.OUT || "/tmp/fp";
const URL = process.env.URL || "http://127.0.0.1:8800";
const W = Number(process.env.W || 1920);
const H = Number(process.env.H || 1080);
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: W, height: H },
  deviceScaleFactor: Number(process.env.DSF || 1.5), // crisper output
});
const page = await ctx.newPage();
await page.goto(URL, { waitUntil: "networkidle", timeout: 60000 });
await page.waitForSelector("canvas", { timeout: 30000 });

// Switch to the requested workflow pack/office (default: development = polished demo data)
const PACK = process.env.PACK || "development";
try {
  const sel = page.locator("select").first();
  await sel.selectOption(PACK, { timeout: 5000 });
  console.log("selected pack:", PACK);
} catch (e) {
  console.log("pack switch failed:", e.message);
}
await page.waitForTimeout(5000); // let Pixi re-mount, agents seat, board load

const dims = await page.evaluate(() => ({
  scrollH: document.documentElement.scrollHeight,
  innerH: window.innerHeight,
}));
console.log("DIMS:", JSON.stringify(dims));

// Whole dashboard, current viewport (the design fits a desktop screen)
await page.screenshot({ path: `${OUT}/fullpage.png` });

// Also bounding box of the office canvas (for the zoom target), in CSS px
const box = await page.evaluate(() => {
  const cs = [...document.querySelectorAll("canvas")];
  cs.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight);
  const r = cs[0].getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
console.log("OFFICE_BOX:", JSON.stringify(box));
console.log("DSF:", Number(process.env.DSF || 1.5));
await browser.close();
