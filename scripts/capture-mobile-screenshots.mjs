#!/usr/bin/env node
/**
 * Capture mobile-viewport screenshots for the mobile design polish pass (#27).
 * Uses iPhone 14 Pro viewport (393x852, dpr 3).
 *
 * Usage: node scripts/capture-mobile-screenshots.mjs
 */
import { chromium, devices } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const BASE_URL = "http://127.0.0.1:8800";
const OUT_DIR = resolve(process.cwd(), "docs/screenshots/mobile");

async function shoot(page, name) {
  const path = `${OUT_DIR}/${name}.png`;
  await page.screenshot({ path, type: "png", fullPage: false });
  console.log(`  ✓ ${name}.png`);
}

async function clickByText(page, text) {
  const el = page.getByText(text, { exact: true }).first();
  await el.waitFor({ state: "visible", timeout: 10000 });
  await el.click();
}

async function wait(page, ms = 900) {
  await page.waitForTimeout(ms);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    ...devices["iPhone 14 Pro"],
  });
  const page = await context.newPage();

  console.log(`> Opening ${BASE_URL} @ iPhone 14 Pro`);
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await wait(page, 1500);

  // Mission Control / Office tab
  await shoot(page, "mobile-01-office");

  // Tasks
  await clickByText(page, "Tasks");
  await wait(page, 1200);
  await shoot(page, "mobile-02-tasks");

  // Ops (skip Chat — it's a full-screen overlay that blocks the tab bar)
  await clickByText(page, "Ops");
  await wait(page, 1200);
  await shoot(page, "mobile-03-ops");

  // More bottom sheet — wait longer so the pack registry is loaded before opening the sheet
  await wait(page, 1500);
  await clickByText(page, "More");
  await wait(page, 1500);
  await shoot(page, "mobile-04-more-sheet");

  // Close the more-sheet by tapping the backdrop near the top (avoid the select in the panel)
  await page.mouse.click(50, 60);
  await wait(page, 500);
  await clickByText(page, "Chat");
  await wait(page, 1200);
  await shoot(page, "mobile-05-chat");

  await browser.close();
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
