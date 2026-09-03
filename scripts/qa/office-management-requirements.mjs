#!/usr/bin/env node

import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const baseUrl = process.env.QA_BASE_URL ?? "http://127.0.0.1:9100";
const runLabel = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = process.env.QA_OUT_DIR ?? path.join("docs", "reports", "qa", "office-management-requirements", runLabel);

function buildCheck(id, pass, details = {}) {
  return { id, pass, details };
}

async function run() {
  await mkdir(outDir, { recursive: true });

  const checks = [];
  const consoleIssues = [];
  const pageErrors = [];

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1728, height: 1080 } });
  const page = await context.newPage();

  page.on("console", (msg) => {
    if (msg.type() === "warning" || msg.type() === "error") {
      consoleIssues.push({ type: msg.type(), text: msg.text() });
    }
  });
  page.on("pageerror", (err) => {
    pageErrors.push({ message: err.message, stack: err.stack ?? null });
  });

  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle");

  const preOpenScreenshot = path.join(outDir, "pre-open.png");
  await page.screenshot({ path: preOpenScreenshot, fullPage: true });

  const announcementButton = page
    .getByRole("button", {
      name: /Announcement|전사 공지|全社告知|全员公告/i,
    })
    .first();
  const announcementButtonVisible = await announcementButton.isVisible().catch(() => false);
  checks.push(
    buildCheck("announcement_button_visible", announcementButtonVisible, {
      expected: "Announcement button is visible in top-right controls.",
    }),
  );

  if (announcementButtonVisible) {
    await announcementButton.click();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(400);
  }

  const announcementHeader = page.getByText(/Company Announcement|전사 공지|全体告知|全员公告/i).first();
  const announcementHeaderVisible = await announcementHeader.isVisible().catch(() => false);
  checks.push(
    buildCheck("announcement_panel_opened", announcementHeaderVisible, {
      expected: "Announcement panel opens after clicking top-right announcement button.",
    }),
  );

  const officeManagementButton = page
    .getByRole("button", {
      name: /Office Management|사무실 관리|オフィス管理|办公室管理/i,
    })
    .first();
  const officeManagementVisible = await officeManagementButton.isVisible().catch(() => false);
  checks.push(
    buildCheck("office_management_button_visible", officeManagementVisible, {
      expected: "Office Management button exists in announcement panel header.",
    }),
  );

  let officeManagementRightOfAnnouncement = false;
  if (officeManagementVisible && announcementHeaderVisible) {
    const [buttonBox, headerBox] = await Promise.all([
      officeManagementButton.boundingBox(),
      announcementHeader.boundingBox(),
    ]);
    officeManagementRightOfAnnouncement = Boolean(
      buttonBox && headerBox && buttonBox.x >= headerBox.x + headerBox.width - 8,
    );
  }
  checks.push(
    buildCheck("office_management_button_right_of_announcement", officeManagementRightOfAnnouncement, {
      expected: "Office Management button is placed to the right of announcement header label.",
    }),
  );

  let colorInputsCount = 0;
  let toneControlsCount = 0;
  if (officeManagementVisible) {
    await officeManagementButton.click();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(350);

    colorInputsCount = await page.locator('input[type="color"]').count();
    const rangeCount = await page.locator('input[type="range"]').count();
    const toneTextVisible = await page
      .getByText(/Tone|톤|トーン|色调/i)
      .first()
      .isVisible()
      .catch(() => false);
    toneControlsCount = rangeCount + (toneTextVisible ? 1 : 0);
  }

  checks.push(
    buildCheck("office_color_picker_available", colorInputsCount > 0, {
      expected: "At least one color picker is available for office/department colors.",
      actual_color_input_count: colorInputsCount,
    }),
  );

  checks.push(
    buildCheck("office_tone_control_available", toneControlsCount > 0, {
      expected: "Tone control exists (slider or explicit tone UI marker).",
      actual_tone_control_signal_count: toneControlsCount,
    }),
  );

  const postOpenScreenshot = path.join(outDir, "post-open.png");
  await page.screenshot({ path: postOpenScreenshot, fullPage: true });

  await context.close();
  await browser.close();

  const failedChecks = checks.filter((check) => !check.pass);
  const summary = {
    out_dir: outDir,
    base_url: baseUrl,
    generated_at: new Date().toISOString(),
    check_counts: {
      total: checks.length,
      passed: checks.length - failedChecks.length,
      failed: failedChecks.length,
    },
    checks,
    failed_checks: failedChecks,
    diagnostics: {
      console_issues: consoleIssues,
      page_errors: pageErrors,
    },
    artifacts: {
      pre_open_screenshot: preOpenScreenshot,
      post_open_screenshot: postOpenScreenshot,
      summary_json: path.join(outDir, "summary.json"),
    },
  };

  await writeFile(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

  if (failedChecks.length > 0 || pageErrors.length > 0) {
    process.exitCode = 1;
  }
}

run().catch((error) => {
  process.stderr.write(`[office-management-requirements] ${error?.stack ?? String(error)}\n`);
  process.exitCode = 1;
});
