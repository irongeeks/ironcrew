import { chromium } from "playwright";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  MAX_DOM_ELEMENTS_PER_VIEW,
  MAX_TEXT_ELEMENTS_PER_VIEW,
  TERMINAL_PANEL_CONTAINER_SELECTOR,
  UI_REACTION_DELTA_MIN,
  WCAG_AA_MIN_CONTRAST,
  dashboardViewLabelRe,
  officeManagerNameRe,
  themeSignalRe,
} from "./constants.mjs";
import { buildCheck, buildMarkdownReport, buildSeverityCounts, resolveCheckSeverity } from "./reporting.mjs";
import {
  analyzeRegionTone,
  closeTerminalPanel,
  collectHeaderButtons,
  collectTerminalPanelStyles,
  collectUiState,
  colorDistance,
  ensureTheme,
  extractThemeStorage,
  hasStorageChanged,
  hasThemePersistValue,
  normalizeThemeValue,
  openTerminalPanelInTasks,
  resolveStoredTheme,
  waitForAppSettled,
} from "./theme-helpers.mjs";
import { collectScopedContrastFromRoot, collectThemeContrastAcrossViews } from "./contrast-audit.mjs";

export async function runOfficeThemeRequirements() {
  const baseUrl = process.env.QA_BASE_URL ?? "http://127.0.0.1:8810";
  const runLabel = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = process.env.QA_OUT_DIR ?? path.join("docs", "reports", "qa", "office-theme-requirements", runLabel);

  await mkdir(outDir, { recursive: true });
  const traceLogPath = path.join(outDir, "trace.log");
  const trace = async (message) => {
    await appendFile(traceLogPath, `${new Date().toISOString()} ${message}\n`, "utf8");
  };
  await trace("run:start");

  const checks = [];
  const consoleIssues = [];
  const pageErrors = [];
  const artifacts = {
    pre_toggle_screenshot: path.join(outDir, "pre-toggle.png"),
    post_toggle_screenshot: path.join(outDir, "post-toggle.png"),
    post_reload_screenshot: path.join(outDir, "post-reload.png"),
    summary_json: path.join(outDir, "summary.json"),
    findings_markdown: path.join(outDir, "findings.md"),
  };

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
  await waitForAppSettled(page, 2_000, 500);
  await trace("phase:initial_loaded");

  await page.screenshot({ path: artifacts.pre_toggle_screenshot, fullPage: true });

  const officeManagerButton = page.getByRole("button", { name: officeManagerNameRe }).first();
  const officeManagerVisible = await officeManagerButton.isVisible().catch(() => false);
  checks.push(
    buildCheck("office_manager_button_visible", officeManagerVisible, {
      expected: "Office Manager button is visible in top controls.",
    }),
  );

  let officeButtonIdx = -1;
  let rightButton = null;
  let rightButtonLocator = null;
  let rightButtonIsThemeLike = false;
  let rightButtonDistancePx = null;

  if (officeManagerVisible) {
    const headerButtons = await collectHeaderButtons(page);
    officeButtonIdx = headerButtons.findIndex((button) =>
      officeManagerNameRe.test(`${button.text} ${button.ariaLabel}`),
    );
    if (officeButtonIdx >= 0) {
      const office = headerButtons[officeButtonIdx];
      const candidates = headerButtons
        .filter((button) => button.idx !== office.idx)
        .map((button) => ({
          ...button,
          dx: button.x - (office.x + office.width),
          dy: Math.abs(button.y - office.y),
        }))
        .filter((button) => button.dx >= -2 && button.dx <= 220 && button.dy <= 26)
        .sort((a, b) => a.dx - b.dx);
      rightButton = candidates[0] ?? null;
      if (rightButton) {
        rightButtonLocator = page.locator("header button").nth(rightButton.idx);
        rightButtonDistancePx = rightButton.dx;
        const labelBlob = `${rightButton.text} ${rightButton.ariaLabel} ${rightButton.html}`;
        rightButtonIsThemeLike = themeSignalRe.test(labelBlob);
      }
    }
  }

  checks.push(
    buildCheck("theme_toggle_right_of_office_manager", Boolean(rightButton), {
      expected: "Theme toggle button exists at the immediate right of Office Manager button.",
      office_button_index: officeButtonIdx,
      right_button: rightButton,
      distance_px: rightButtonDistancePx,
    }),
  );

  checks.push(
    buildCheck("theme_toggle_uses_sun_moon_representation", rightButtonIsThemeLike, {
      expected: "Theme toggle expresses sun/moon (icon or accessible name).",
      detected_text: rightButton ? rightButton.text : "",
      detected_aria_label: rightButton ? rightButton.ariaLabel : "",
    }),
  );

  const beforeState = await collectUiState(page, officeManagerNameRe);
  const beforeThemeStorage = extractThemeStorage(beforeState.storage);
  await trace("phase:before_state_collected");

  const canvasLocator = page.locator("canvas").first();
  const canvasVisible = await canvasLocator.isVisible().catch(() => false);
  const beforeCanvasBox = canvasVisible ? await canvasLocator.boundingBox() : null;
  const beforeCanvasTone = beforeCanvasBox
    ? await analyzeRegionTone(artifacts.pre_toggle_screenshot, beforeCanvasBox)
    : null;

  let toggleClicked = false;
  if (rightButtonLocator) {
    await rightButtonLocator.click({ timeout: 5_000 });
    await waitForAppSettled(page, 2_000, 450);
    toggleClicked = true;
    await page.screenshot({ path: artifacts.post_toggle_screenshot, fullPage: true });
  }
  await trace(`phase:toggle_done:clicked=${toggleClicked}`);

  const afterState = await collectUiState(page, officeManagerNameRe);
  const afterThemeStorage = extractThemeStorage(afterState.storage);

  const themeAttrChanged =
    beforeState.attrs.htmlClass !== afterState.attrs.htmlClass ||
    beforeState.attrs.bodyClass !== afterState.attrs.bodyClass ||
    beforeState.attrs.htmlDataTheme !== afterState.attrs.htmlDataTheme ||
    beforeState.attrs.bodyDataTheme !== afterState.attrs.bodyDataTheme ||
    beforeState.attrs.rootDataTheme !== afterState.attrs.rootDataTheme;
  const themeStorageChanged = hasStorageChanged(beforeThemeStorage, afterThemeStorage);
  const themeStateChanged = toggleClicked && (themeAttrChanged || themeStorageChanged);

  checks.push(
    buildCheck("theme_toggle_changes_theme_state", themeStateChanged, {
      expected: "After toggle click, theme-related DOM attrs/classes or localStorage entries should change.",
      toggle_clicked: toggleClicked,
      attrs_before: beforeState.attrs,
      attrs_after: afterState.attrs,
      theme_storage_before: beforeThemeStorage,
      theme_storage_after: afterThemeStorage,
    }),
  );

  const styleDeltaSignals = [
    {
      target: "body.background",
      delta: colorDistance(beforeState.styles.body?.background, afterState.styles.body?.background),
    },
    {
      target: "header.background",
      delta: colorDistance(beforeState.styles.header?.background, afterState.styles.header?.background),
    },
    {
      target: "office_button.background",
      delta: colorDistance(beforeState.styles.officeButton?.background, afterState.styles.officeButton?.background),
    },
    {
      target: "office_button.color",
      delta: colorDistance(beforeState.styles.officeButton?.color, afterState.styles.officeButton?.color),
    },
  ];
  const changedSignalCount = styleDeltaSignals.filter((signal) => signal.delta >= UI_REACTION_DELTA_MIN).length;
  checks.push(
    buildCheck("global_ui_reacts_to_theme_toggle", toggleClicked && changedSignalCount >= 2, {
      expected: "At least two major UI color signals should change after theme toggle.",
      toggle_clicked: toggleClicked,
      changed_signal_count: changedSignalCount,
      style_delta_signals: styleDeltaSignals,
    }),
  );

  const officeButtonBackgroundDelta =
    styleDeltaSignals.find((signal) => signal.target === "office_button.background")?.delta ?? 0;
  const officeButtonColorDelta =
    styleDeltaSignals.find((signal) => signal.target === "office_button.color")?.delta ?? 0;
  const officeButtonReactive =
    toggleClicked &&
    (officeButtonBackgroundDelta >= UI_REACTION_DELTA_MIN || officeButtonColorDelta >= UI_REACTION_DELTA_MIN);
  checks.push(
    buildCheck("office_manager_button_reacts_to_theme_toggle", officeButtonReactive, {
      expected: "Office Manager button should also react to dark/light theme changes.",
      toggle_clicked: toggleClicked,
      office_button_background_delta: officeButtonBackgroundDelta,
      office_button_color_delta: officeButtonColorDelta,
      delta_threshold: UI_REACTION_DELTA_MIN,
      office_button_style_before: beforeState.styles.officeButton,
      office_button_style_after: afterState.styles.officeButton,
    }),
  );

  checks.push(
    buildCheck("theme_persisted_to_localstorage", hasThemePersistValue(afterThemeStorage), {
      expected: "localStorage stores explicit dark/light theme preference.",
      theme_storage_after: afterThemeStorage,
    }),
  );

  const expectedPersistedTheme = resolveStoredTheme(afterThemeStorage);
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForAppSettled(page, 2_000, 450);
  await page.screenshot({ path: artifacts.post_reload_screenshot, fullPage: true });
  await trace("phase:post_reload_collected");

  const reloadedState = await collectUiState(page, officeManagerNameRe);
  const reloadedThemeStorage = extractThemeStorage(reloadedState.storage);
  const reloadedAttrTheme =
    normalizeThemeValue(reloadedState.attrs.htmlDataTheme) ??
    normalizeThemeValue(reloadedState.attrs.bodyDataTheme) ??
    normalizeThemeValue(reloadedState.attrs.rootDataTheme);
  const reloadedStoredTheme = resolveStoredTheme(reloadedThemeStorage);
  const hardRefreshPass = Boolean(
    expectedPersistedTheme &&
    reloadedAttrTheme === expectedPersistedTheme &&
    reloadedStoredTheme === expectedPersistedTheme,
  );

  checks.push(
    buildCheck("theme_persists_after_hard_refresh", hardRefreshPass, {
      expected: "Chosen theme remains identical after hard refresh and localStorage still matches.",
      expected_theme: expectedPersistedTheme,
      reloaded_attr_theme: reloadedAttrTheme,
      reloaded_storage_theme: reloadedStoredTheme,
      attrs_after_reload: reloadedState.attrs,
      theme_storage_after_reload: reloadedThemeStorage,
    }),
  );

  const darkContrastAudit = await collectThemeContrastAcrossViews(page, "dark", rightButtonLocator, trace);
  await trace("phase:dark_contrast_done");
  checks.push(
    buildCheck("wcag_aa_contrast_45_dark_theme_all_text", darkContrastAudit.pass, {
      expected: "All visible text elements satisfy WCAG AA 4.5:1 in dark theme across major views.",
      minimum_required_ratio: WCAG_AA_MIN_CONTRAST,
      sampled_text_nodes: darkContrastAudit.sampled_text_nodes,
      failing_text_nodes: darkContrastAudit.failing_text_nodes,
      min_contrast_ratio: darkContrastAudit.min_contrast_ratio,
      views_scanned: darkContrastAudit.views_scanned,
      top_violations: darkContrastAudit.violations,
    }),
  );

  const lightContrastAudit = await collectThemeContrastAcrossViews(page, "light", rightButtonLocator, trace);
  await trace("phase:light_contrast_done");
  checks.push(
    buildCheck("wcag_aa_contrast_45_light_theme_all_text", lightContrastAudit.pass, {
      expected: "All visible text elements satisfy WCAG AA 4.5:1 in light theme across major views.",
      minimum_required_ratio: WCAG_AA_MIN_CONTRAST,
      sampled_text_nodes: lightContrastAudit.sampled_text_nodes,
      failing_text_nodes: lightContrastAudit.failing_text_nodes,
      min_contrast_ratio: lightContrastAudit.min_contrast_ratio,
      views_scanned: lightContrastAudit.views_scanned,
      top_violations: lightContrastAudit.violations,
    }),
  );

  const dashboardLightView = lightContrastAudit.per_view.find((view) => dashboardViewLabelRe.test(view.view_label));
  const dashboardFocusPass = Boolean(
    dashboardLightView &&
    !dashboardLightView.truncated &&
    dashboardLightView.sampled_text_nodes > 0 &&
    dashboardLightView.failing_text_nodes === 0 &&
    (dashboardLightView.min_contrast_ratio ?? 0) >= WCAG_AA_MIN_CONTRAST,
  );
  checks.push(
    buildCheck("dashboard_light_mode_contrast_focus", dashboardFocusPass, {
      expected: "Dashboard view should be individually readable in light mode (WCAG AA 4.5:1).",
      minimum_required_ratio: WCAG_AA_MIN_CONTRAST,
      view_label: dashboardLightView?.view_label ?? null,
      sampled_text_nodes: dashboardLightView?.sampled_text_nodes ?? 0,
      failing_text_nodes: dashboardLightView?.failing_text_nodes ?? 0,
      min_contrast_ratio: dashboardLightView?.min_contrast_ratio ?? null,
      top_violations: (dashboardLightView?.violations ?? []).slice(0, 15),
    }),
  );
  await trace("phase:dashboard_focus_done");

  const darkThemeReadyForTerminal = await ensureTheme(page, "dark", rightButtonLocator, trace);
  const darkTerminalOpen = await openTerminalPanelInTasks(page, trace);
  const darkTerminalStyles = darkTerminalOpen.panel_visible
    ? await collectTerminalPanelStyles(darkTerminalOpen.panel_handle)
    : null;
  if (darkTerminalOpen.panel_visible) {
    await closeTerminalPanel(page, trace);
  }

  const lightThemeReadyForTerminal = await ensureTheme(page, "light", rightButtonLocator, trace);
  const lightTerminalOpen = await openTerminalPanelInTasks(page, trace);
  const lightTerminalStyles = lightTerminalOpen.panel_visible
    ? await collectTerminalPanelStyles(lightTerminalOpen.panel_handle)
    : null;
  const terminalLightContrastAudit = lightTerminalOpen.panel_visible
    ? await collectScopedContrastFromRoot(
        lightTerminalOpen.panel_handle,
        WCAG_AA_MIN_CONTRAST,
        MAX_TEXT_ELEMENTS_PER_VIEW,
      )
    : {
        root_found: false,
        sampled_text_nodes: 0,
        failing_text_nodes: 0,
        min_contrast_ratio: null,
        truncated: false,
        violations: [],
        max_samples: MAX_TEXT_ELEMENTS_PER_VIEW,
        max_dom_elements: MAX_DOM_ELEMENTS_PER_VIEW,
      };

  const terminalPanelBackgroundDelta = colorDistance(darkTerminalStyles?.background, lightTerminalStyles?.background);
  const terminalPanelTextDelta = colorDistance(darkTerminalStyles?.color, lightTerminalStyles?.color);
  const terminalPanelReactive = Boolean(
    darkThemeReadyForTerminal.matched &&
    lightThemeReadyForTerminal.matched &&
    darkTerminalOpen.panel_visible &&
    lightTerminalOpen.panel_visible &&
    (terminalPanelBackgroundDelta >= UI_REACTION_DELTA_MIN || terminalPanelTextDelta >= UI_REACTION_DELTA_MIN),
  );
  checks.push(
    buildCheck("terminal_panel_reacts_to_dark_light", terminalPanelReactive, {
      expected: "Terminal panel itself should change visual tone between dark and light themes.",
      dark_theme_ready: darkThemeReadyForTerminal,
      light_theme_ready: lightThemeReadyForTerminal,
      dark_panel_open: {
        nav_result: darkTerminalOpen.nav_result,
        titled_button_count: darkTerminalOpen.titled_button_count,
        terminal_button_count: darkTerminalOpen.terminal_button_count,
        clicked_terminal_button: darkTerminalOpen.clicked_terminal_button,
        matched_terminal_button_title: darkTerminalOpen.matched_terminal_button_title,
        panel_visible: darkTerminalOpen.panel_visible,
      },
      light_panel_open: {
        nav_result: lightTerminalOpen.nav_result,
        titled_button_count: lightTerminalOpen.titled_button_count,
        terminal_button_count: lightTerminalOpen.terminal_button_count,
        clicked_terminal_button: lightTerminalOpen.clicked_terminal_button,
        matched_terminal_button_title: lightTerminalOpen.matched_terminal_button_title,
        panel_visible: lightTerminalOpen.panel_visible,
      },
      dark_panel_style: darkTerminalStyles,
      light_panel_style: lightTerminalStyles,
      panel_background_delta: terminalPanelBackgroundDelta,
      panel_text_color_delta: terminalPanelTextDelta,
      delta_threshold: UI_REACTION_DELTA_MIN,
    }),
  );

  const terminalLightContrastPass = Boolean(
    lightThemeReadyForTerminal.matched &&
    lightTerminalOpen.panel_visible &&
    terminalLightContrastAudit.root_found &&
    !terminalLightContrastAudit.truncated &&
    terminalLightContrastAudit.sampled_text_nodes > 0 &&
    terminalLightContrastAudit.failing_text_nodes === 0 &&
    (terminalLightContrastAudit.min_contrast_ratio ?? 0) >= WCAG_AA_MIN_CONTRAST,
  );
  checks.push(
    buildCheck("terminal_panel_light_mode_contrast", terminalLightContrastPass, {
      expected: "Terminal panel text should satisfy WCAG AA 4.5:1 in light mode.",
      minimum_required_ratio: WCAG_AA_MIN_CONTRAST,
      panel_selector: TERMINAL_PANEL_CONTAINER_SELECTOR,
      panel_opened: lightTerminalOpen.panel_visible,
      sampled_text_nodes: terminalLightContrastAudit.sampled_text_nodes,
      failing_text_nodes: terminalLightContrastAudit.failing_text_nodes,
      min_contrast_ratio: terminalLightContrastAudit.min_contrast_ratio,
      top_violations: terminalLightContrastAudit.violations.slice(0, 20),
      panel_style: lightTerminalStyles,
    }),
  );
  if (lightTerminalOpen.panel_visible) {
    await closeTerminalPanel(page, trace);
  }
  await trace("phase:terminal_focus_done");

  let afterCanvasTone = null;
  if (toggleClicked && beforeCanvasBox) {
    afterCanvasTone = await analyzeRegionTone(artifacts.post_toggle_screenshot, beforeCanvasBox);
  }

  const canvasToneDelta =
    beforeCanvasTone && afterCanvasTone ? Math.abs(beforeCanvasTone.luminance - afterCanvasTone.luminance) : 0;
  checks.push(
    buildCheck("office_canvas_tone_changes_between_dark_and_light", toggleClicked && canvasToneDelta >= 0.06, {
      expected: "Office visual tone should noticeably change between dark/light modes.",
      toggle_clicked: toggleClicked,
      luminance_delta: canvasToneDelta,
      before_canvas_tone: beforeCanvasTone,
      after_canvas_tone: afterCanvasTone,
    }),
  );

  const checksWithSeverity = checks.map((check) => ({
    ...check,
    severity: resolveCheckSeverity(check),
  }));
  const failedChecks = checksWithSeverity.filter((check) => !check.pass);
  const failedCriticalHighChecks = failedChecks.filter(
    (check) => check.severity === "CRITICAL" || check.severity === "HIGH",
  );
  const failedMediumLowChecks = failedChecks.filter((check) => check.severity === "MEDIUM" || check.severity === "LOW");
  const severityCounts = buildSeverityCounts(checksWithSeverity);

  const summary = {
    base_url: baseUrl,
    generated_at: new Date().toISOString(),
    out_dir: outDir,
    check_counts: {
      total: checksWithSeverity.length,
      passed: checksWithSeverity.length - failedChecks.length,
      failed: failedChecks.length,
    },
    severity_counts: severityCounts,
    checks: checksWithSeverity,
    failed_checks: failedChecks,
    failed_checks_critical_high: failedCriticalHighChecks,
    failed_checks_medium_low: failedMediumLowChecks,
    diagnostics: {
      console_issues: consoleIssues,
      page_errors: pageErrors,
    },
    wcag_audit: {
      dark: darkContrastAudit,
      light: lightContrastAudit,
    },
    targeted_audit: {
      dashboard_light: dashboardLightView ?? null,
      terminal_light: terminalLightContrastAudit,
      terminal_theme_reactivity: {
        dark_style: darkTerminalStyles,
        light_style: lightTerminalStyles,
        background_delta: terminalPanelBackgroundDelta,
        text_delta: terminalPanelTextDelta,
      },
    },
    artifacts,
    execution: {
      failed_critical_high_count: failedCriticalHighChecks.length,
      failed_medium_low_count: failedMediumLowChecks.length,
      page_error_count: pageErrors.length,
      result: failedCriticalHighChecks.length > 0 || pageErrors.length > 0 ? "FAIL" : "PASS",
    },
  };

  await writeFile(artifacts.summary_json, JSON.stringify(summary, null, 2), "utf8");
  await writeFile(artifacts.findings_markdown, `${buildMarkdownReport(summary)}\n`, "utf8");
  await trace("phase:summary_written");
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

  await context.close();
  await browser.close();
  await trace("phase:browser_closed");

  if (failedCriticalHighChecks.length > 0 || pageErrors.length > 0) {
    process.exitCode = 1;
  }
}
