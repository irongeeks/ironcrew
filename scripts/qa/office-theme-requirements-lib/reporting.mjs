import { CRITICAL_CONTRAST_MIN, WCAG_AA_MIN_CONTRAST } from "./constants.mjs";

export function buildCheck(id, pass, details = {}) {
  return { id, pass, details };
}

function classifyContrastSeverity(minContrastRatio) {
  if (typeof minContrastRatio !== "number") return "HIGH";
  if (minContrastRatio < CRITICAL_CONTRAST_MIN) return "CRITICAL";
  if (minContrastRatio < WCAG_AA_MIN_CONTRAST) return "HIGH";
  return "LOW";
}

export function resolveCheckSeverity(check) {
  if (check.pass) return "PASS";

  if (
    check.id === "wcag_aa_contrast_45_dark_theme_all_text" ||
    check.id === "wcag_aa_contrast_45_light_theme_all_text" ||
    check.id === "dashboard_light_mode_contrast_focus" ||
    check.id === "terminal_panel_light_mode_contrast"
  ) {
    return classifyContrastSeverity(check.details?.min_contrast_ratio);
  }

  if (
    check.id === "office_manager_button_visible" ||
    check.id === "theme_toggle_right_of_office_manager" ||
    check.id === "theme_toggle_changes_theme_state" ||
    check.id === "theme_persisted_to_localstorage" ||
    check.id === "theme_persists_after_hard_refresh"
  ) {
    return "CRITICAL";
  }

  if (
    check.id === "theme_toggle_uses_sun_moon_representation" ||
    check.id === "global_ui_reacts_to_theme_toggle" ||
    check.id === "office_manager_button_reacts_to_theme_toggle" ||
    check.id === "office_canvas_tone_changes_between_dark_and_light" ||
    check.id === "terminal_panel_reacts_to_dark_light"
  ) {
    return "HIGH";
  }

  return "MEDIUM";
}

export function buildSeverityCounts(checks) {
  return checks.reduce(
    (acc, check) => {
      const key = check.severity;
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    },
    { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, PASS: 0 },
  );
}

function renderFindingLine(check) {
  if (
    check.id === "wcag_aa_contrast_45_dark_theme_all_text" ||
    check.id === "wcag_aa_contrast_45_light_theme_all_text" ||
    check.id === "dashboard_light_mode_contrast_focus" ||
    check.id === "terminal_panel_light_mode_contrast"
  ) {
    return [
      `- [${check.severity}] ${check.id}`,
      `  - min_ratio: ${check.details?.min_contrast_ratio ?? "n/a"}`,
      `  - failing/sampled: ${check.details?.failing_text_nodes ?? "n/a"}/${check.details?.sampled_text_nodes ?? "n/a"}`,
    ].join("\n");
  }
  if (check.id === "office_manager_button_reacts_to_theme_toggle") {
    return [
      `- [${check.severity}] ${check.id}`,
      `  - background_delta: ${check.details?.office_button_background_delta ?? "n/a"}`,
      `  - color_delta: ${check.details?.office_button_color_delta ?? "n/a"}`,
    ].join("\n");
  }
  if (check.id === "terminal_panel_reacts_to_dark_light") {
    return [
      `- [${check.severity}] ${check.id}`,
      `  - background_delta: ${check.details?.panel_background_delta ?? "n/a"}`,
      `  - color_delta: ${check.details?.panel_text_color_delta ?? "n/a"}`,
    ].join("\n");
  }
  return `- [${check.severity}] ${check.id}`;
}

export function buildMarkdownReport(summary) {
  const criticalHigh = summary.failed_checks.filter(
    (check) => check.severity === "CRITICAL" || check.severity === "HIGH",
  );
  const mediumLow = summary.failed_checks.filter((check) => check.severity === "MEDIUM" || check.severity === "LOW");

  const criticalHighLines =
    criticalHigh.length > 0 ? criticalHigh.map((check) => renderFindingLine(check)).join("\n") : "- none";
  const mediumLowLines =
    mediumLow.length > 0 ? mediumLow.map((check) => renderFindingLine(check)).join("\n") : "- none";

  return [
    "# Office Theme QA Report",
    "",
    `- Generated at: ${summary.generated_at}`,
    `- Base URL: ${summary.base_url}`,
    `- Result: ${summary.execution.result}`,
    `- Checks: ${summary.check_counts.passed}/${summary.check_counts.total} passed`,
    "",
    "## Immediate Fix (CRITICAL/HIGH)",
    criticalHighLines,
    "",
    "## Warning Only (MEDIUM/LOW)",
    mediumLowLines,
    "",
    "## Severity Counts",
    `- CRITICAL: ${summary.severity_counts.CRITICAL}`,
    `- HIGH: ${summary.severity_counts.HIGH}`,
    `- MEDIUM: ${summary.severity_counts.MEDIUM}`,
    `- LOW: ${summary.severity_counts.LOW}`,
    `- PASS: ${summary.severity_counts.PASS}`,
    "",
    "## Artifacts",
    `- summary_json: ${summary.artifacts.summary_json}`,
    `- pre_toggle_screenshot: ${summary.artifacts.pre_toggle_screenshot}`,
    `- post_toggle_screenshot: ${summary.artifacts.post_toggle_screenshot}`,
    `- post_reload_screenshot: ${summary.artifacts.post_reload_screenshot}`,
  ].join("\n");
}
