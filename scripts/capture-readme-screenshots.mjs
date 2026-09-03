#!/usr/bin/env node
/**
 * One-off script: launch Chromium via Playwright, walk through the in-app
 * onboarding wizard, then capture all README screenshots at 2560x1440.
 *
 * Usage: node scripts/capture-readme-screenshots.mjs
 * Prereqs: dev server on http://127.0.0.1:8800, fresh DB (onboarding visible).
 */
import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const BASE_URL = "http://127.0.0.1:8800";
const OUT_DIR = resolve(process.cwd(), "docs/screenshots");

const ONBOARDING_VIEWPORT = { width: 1680, height: 1050 };
const MAIN_VIEWPORT = { width: 1600, height: 1000 };

async function shoot(page, name) {
  const path = `${OUT_DIR}/${name}.png`;
  await page.screenshot({ path, type: "png", fullPage: false });
  console.log(`  ✓ ${name}.png`);
}

async function clickByText(page, text, { nth = 0 } = {}) {
  const locator = page.getByText(text, { exact: true }).nth(nth);
  await locator.waitFor({ state: "visible", timeout: 15000 });
  await locator.click();
}

async function waitSettle(page, ms = 900) {
  await page.waitForTimeout(ms);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: ONBOARDING_VIEWPORT,
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();

  console.log(`> Opening ${BASE_URL}`);
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await waitSettle(page, 1500);

  // ───── Onboarding wizard (only if visible) ─────
  const wizardVisible = await page
    .getByText("Welcome to", { exact: false })
    .first()
    .waitFor({ state: "visible", timeout: 8000 })
    .then(() => true)
    .catch(() => false);

  if (wizardVisible) {
    await waitSettle(page);
    await shoot(page, "onboarding-01-welcome");
    await clickByText(page, "Next →");
    await waitSettle(page);
    await shoot(page, "onboarding-02-provider");
    await clickByText(page, "Next →");
    await waitSettle(page);
    await shoot(page, "onboarding-03-extras");
    await clickByText(page, "Next →");
    await waitSettle(page);
    await shoot(page, "onboarding-04-knowledge");
    await clickByText(page, "Skip");
    await waitSettle(page, 1500);
    await shoot(page, "onboarding-05-ready");
    await clickByText(page, "Launch Office →");
    await waitSettle(page, 2500);
  } else {
    console.log("  (onboarding not shown — skipping wizard captures)");
  }

  // Switch to larger viewport for main views
  await page.setViewportSize(MAIN_VIEWPORT);
  await waitSettle(page, 1500);

  // ───── Main app views (dark by default) ─────
  // Office (landing) — full Mission Control layout (3-column: agents, office+kanban+metrics, chat)
  await shoot(page, "screenshot-office");

  // Tasks
  await clickByText(page, "TASKS");
  await waitSettle(page, 1200);
  await shoot(page, "screenshot-tasks");

  // Workflows
  await clickByText(page, "WORKFLOWS");
  await waitSettle(page, 1200);
  await shoot(page, "screenshot-workflows");

  // Roster
  await clickByText(page, "ROSTER");
  await waitSettle(page, 1200);
  await shoot(page, "screenshot-roster");

  // Settings (Config)
  await clickByText(page, "SETTINGS");
  await waitSettle(page, 1200);
  await shoot(page, "screenshot-config");

  // ───── Light theme: back to office, flip theme, reshoot ─────
  await clickByText(page, "OFFICE");
  await waitSettle(page, 1200);

  // Theme toggle: OctoOfficeTopBar has a button with title/aria-label for theme.
  // Try common selectors; fall back to evaluating document theme attribute.
  const themeBtn = page
    .locator(
      'button[title*="theme" i], button[aria-label*="theme" i], button[title*="Light" i], button[title*="Dark" i]',
    )
    .first();
  if (await themeBtn.count()) {
    await themeBtn.click();
  } else {
    // Fallback: set attribute directly so screenshot reflects light palette.
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  }
  await waitSettle(page, 1500);
  await shoot(page, "screenshot-office-light");

  await browser.close();
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
