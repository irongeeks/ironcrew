import sharp from "sharp";
import {
  TERMINAL_PANEL_CONTAINER_SELECTOR,
  terminalOutputButtonRe,
  terminalTabLabelRe,
  tasksViewLabelRe,
  themeStorageRe,
  themeValueRe,
} from "./constants.mjs";

export function parseRgb(color) {
  if (typeof color !== "string") return null;
  const m = color.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/i);
  if (!m) return null;
  return {
    r: Number(m[1]),
    g: Number(m[2]),
    b: Number(m[3]),
    a: m[4] === undefined ? 1 : Number(m[4]),
  };
}

export function colorDistance(a, b) {
  const p1 = parseRgb(a);
  const p2 = parseRgb(b);
  if (!p1 || !p2) return 0;
  return Math.sqrt((p1.r - p2.r) ** 2 + (p1.g - p2.g) ** 2 + (p1.b - p2.b) ** 2);
}

export function extractThemeStorage(storage) {
  return Object.fromEntries(
    Object.entries(storage ?? {}).filter(([key, value]) => {
      if (themeStorageRe.test(key)) return true;
      return typeof value === "string" && themeValueRe.test(value);
    }),
  );
}

export function hasThemePersistValue(storageEntries) {
  return Object.entries(storageEntries).some(([key, value]) => {
    if (themeStorageRe.test(key) && typeof value === "string" && themeValueRe.test(value)) return true;
    return false;
  });
}

export function hasStorageChanged(before, after) {
  const beforeKeys = Object.keys(before);
  const afterKeys = Object.keys(after);
  if (beforeKeys.length !== afterKeys.length) return true;
  const keySet = new Set([...beforeKeys, ...afterKeys]);
  for (const key of keySet) {
    if ((before[key] ?? null) !== (after[key] ?? null)) return true;
  }
  return false;
}

export function normalizeThemeValue(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "dark") return "dark";
  if (normalized === "light") return "light";
  return null;
}

export function resolveStoredTheme(storageEntries) {
  for (const [key, value] of Object.entries(storageEntries ?? {})) {
    if (!themeStorageRe.test(key) || typeof value !== "string") continue;
    const normalized = normalizeThemeValue(value);
    if (normalized) return normalized;
  }
  return null;
}

function computeLuminance(r, g, b) {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

export async function analyzeRegionTone(imagePath, box) {
  if (!box) return null;
  const meta = await sharp(imagePath).metadata();
  const imageW = meta.width ?? 0;
  const imageH = meta.height ?? 0;
  if (!imageW || !imageH) return null;

  const left = Math.max(0, Math.floor(box.x));
  const top = Math.max(0, Math.floor(box.y));
  const maxWidth = Math.max(0, imageW - left);
  const maxHeight = Math.max(0, imageH - top);
  const width = Math.max(1, Math.min(maxWidth, Math.floor(box.width)));
  const height = Math.max(1, Math.min(maxHeight, Math.floor(box.height)));
  if (!width || !height) return null;

  const stats = await sharp(imagePath).extract({ left, top, width, height }).stats();

  const [red, green, blue] = stats.channels.map((ch) => ch.mean);
  return {
    red,
    green,
    blue,
    luminance: computeLuminance(red, green, blue),
    region: { left, top, width, height },
  };
}

export async function collectHeaderButtons(page) {
  return page.evaluate(() => {
    return Array.from(document.querySelectorAll("header button")).map((button, idx) => {
      const rect = button.getBoundingClientRect();
      return {
        idx,
        text: (button.textContent ?? "").trim(),
        ariaLabel: button.getAttribute("aria-label") ?? "",
        html: (button.innerHTML ?? "").slice(0, 180),
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      };
    });
  });
}

export async function collectUiState(page, officeManagerNameRe) {
  const namePattern = {
    source: officeManagerNameRe.source,
    flags: officeManagerNameRe.flags,
  };
  return page.evaluate((payload) => {
    const officeNameRe = new RegExp(payload.source, payload.flags);
    const body = document.body;
    const html = document.documentElement;
    const header = document.querySelector("header");
    const officeButton = Array.from(document.querySelectorAll("header button")).find((button) =>
      officeNameRe.test(button.textContent ?? ""),
    );

    const readStyles = (el) => {
      if (!el) return null;
      const style = getComputedStyle(el);
      return {
        background: style.backgroundColor,
        color: style.color,
        border: style.borderColor,
      };
    };

    const storage = {};
    try {
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (!key) continue;
        storage[key] = localStorage.getItem(key) ?? "";
      }
    } catch {
      // ignore storage read errors
    }

    return {
      attrs: {
        htmlClass: html.className,
        bodyClass: body.className,
        htmlDataTheme: html.getAttribute("data-theme"),
        bodyDataTheme: body.getAttribute("data-theme"),
        rootDataTheme: document.querySelector("#root")?.getAttribute("data-theme") ?? null,
      },
      styles: {
        body: readStyles(body),
        header: readStyles(header),
        officeButton: readStyles(officeButton),
      },
      storage,
    };
  }, namePattern);
}

export async function ensureTheme(page, desiredTheme, toggleLocator, onTrace = null) {
  if (onTrace) await onTrace(`ensureTheme:start:${desiredTheme}`);
  let finalTheme = normalizeThemeValue(await page.evaluate(() => document.documentElement.getAttribute("data-theme")));
  let togglesUsed = 0;

  while (finalTheme !== desiredTheme && toggleLocator && togglesUsed < 2) {
    await toggleLocator.click({ timeout: 5_000 });
    await waitForAppSettled(page);
    togglesUsed += 1;
    if (onTrace) await onTrace(`ensureTheme:toggle:${desiredTheme}:attempt=${togglesUsed}`);
    finalTheme = normalizeThemeValue(await page.evaluate(() => document.documentElement.getAttribute("data-theme")));
  }

  if (onTrace) await onTrace(`ensureTheme:done:${desiredTheme}:final=${finalTheme ?? "null"}`);
  return {
    requested_theme: desiredTheme,
    final_theme: finalTheme,
    toggles_used: togglesUsed,
    matched: finalTheme === desiredTheme,
  };
}

export async function clickSidebarViewByLabel(page, labelRe, onTrace = null) {
  const navButtons = page.locator("aside nav button");
  const navCount = await navButtons.count().catch(() => 0);
  if (navCount === 0) return { clicked: false, nav_count: 0, matched_label: null, matched_index: -1 };

  for (let idx = 0; idx < navCount; idx += 1) {
    const navButton = navButtons.nth(idx);
    const label = ((await navButton.textContent().catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
    if (!labelRe.test(label)) continue;
    await navButton.click({ timeout: 5_000 }).catch(() => {});
    await waitForAppSettled(page, 1_600, 320);
    if (onTrace) await onTrace(`nav:clicked:${label}:idx=${idx}`);
    return { clicked: true, nav_count: navCount, matched_label: label, matched_index: idx };
  }

  if (onTrace) await onTrace(`nav:not_found:${String(labelRe)}`);
  return { clicked: false, nav_count: navCount, matched_label: null, matched_index: -1 };
}

export async function openTerminalPanelInTasks(page, onTrace = null) {
  const navResult = await clickSidebarViewByLabel(page, tasksViewLabelRe, onTrace);
  const terminalButtons = page.locator("button[title]");
  const titledButtonCount = await terminalButtons.count().catch(() => 0);
  let terminalButtonMatchCount = 0;
  let clickedTerminalButton = false;
  let matchedTerminalButtonTitle = null;

  if (titledButtonCount > 0) {
    for (let idx = 0; idx < titledButtonCount; idx += 1) {
      const candidate = terminalButtons.nth(idx);
      const title = (await candidate.getAttribute("title").catch(() => "")) ?? "";
      if (!terminalOutputButtonRe.test(title)) continue;
      terminalButtonMatchCount += 1;
      const visible = await candidate.isVisible().catch(() => false);
      if (!visible) continue;
      await candidate.click({ timeout: 5_000 }).catch(() => {});
      clickedTerminalButton = true;
      matchedTerminalButtonTitle = title;
      break;
    }
  }

  await waitForAppSettled(page, 1_800, 360);
  const panelLocator = page.locator(TERMINAL_PANEL_CONTAINER_SELECTOR).filter({ hasText: terminalTabLabelRe }).first();
  const panelVisible = await panelLocator.isVisible().catch(() => false);
  const terminalTabVisible = await panelLocator
    .locator("button")
    .filter({ hasText: terminalTabLabelRe })
    .first()
    .isVisible()
    .catch(() => false);
  const panelHandle = panelVisible ? await panelLocator.elementHandle() : null;

  if (onTrace) {
    await onTrace(
      `terminal:open:tasks=${navResult.clicked}:buttons=${terminalButtonMatchCount}:clicked=${clickedTerminalButton}:panel=${panelVisible}:tab=${terminalTabVisible}`,
    );
  }

  return {
    nav_result: navResult,
    titled_button_count: titledButtonCount,
    terminal_button_count: terminalButtonMatchCount,
    clicked_terminal_button: clickedTerminalButton,
    matched_terminal_button_title: matchedTerminalButtonTitle,
    panel_visible: panelVisible,
    terminal_tab_visible: terminalTabVisible,
    panel_handle: panelHandle,
  };
}

export async function closeTerminalPanel(page, onTrace = null) {
  await page.keyboard.press("Escape").catch(() => {});
  await waitForAppSettled(page, 1_200, 260);
  const panelStillVisible = await page
    .locator(TERMINAL_PANEL_CONTAINER_SELECTOR)
    .filter({ hasText: terminalTabLabelRe })
    .first()
    .isVisible()
    .catch(() => false);
  if (onTrace) await onTrace(`terminal:close:still_visible=${panelStillVisible}`);
  return !panelStillVisible;
}

export async function collectTerminalPanelStyles(panelHandle) {
  if (!panelHandle) return null;
  return panelHandle.evaluate((root) => {
    if (!(root instanceof HTMLElement)) return null;
    const style = getComputedStyle(root);
    return {
      background: style.backgroundColor,
      color: style.color,
      border: style.borderColor,
      class_name: root.className,
      data_theme: document.documentElement.getAttribute("data-theme"),
    };
  });
}

export async function waitForAppSettled(page, networkTimeoutMs = 2_000, settleDelayMs = 350) {
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: networkTimeoutMs }).catch(() => {});
  if (settleDelayMs > 0) {
    await page.waitForTimeout(settleDelayMs);
  }
}
