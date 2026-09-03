import {
  MAX_DOM_ELEMENTS_PER_VIEW,
  MAX_TEXT_ELEMENTS_PER_VIEW,
  SIDEBAR_VIEW_SCAN_LIMIT,
  WCAG_AA_MIN_CONTRAST,
} from "./constants.mjs";
import { ensureTheme, waitForAppSettled } from "./theme-helpers.mjs";

export async function collectCurrentViewContrast(page, minimumContrast, maxSamplesPerView) {
  return page.evaluate(
    ({ minContrast, maxSamples, maxDomElements }) => {
      const textSignalRe = /[A-Za-z0-9가-힣ぁ-んァ-ヶ一-龯]/;
      const skipTagSet = new Set(["script", "style", "noscript"]);

      const parseColor = (raw) => {
        if (typeof raw !== "string") return null;
        const value = raw.trim().toLowerCase();
        if (!value) return null;
        if (value === "transparent") return { r: 0, g: 0, b: 0, a: 0 };

        const rgbMatch = value.match(/^rgba?\(([^)]+)\)$/);
        if (rgbMatch) {
          const parts = rgbMatch[1].split(",").map((part) => part.trim());
          if (parts.length < 3) return null;
          return {
            r: Number(parts[0]),
            g: Number(parts[1]),
            b: Number(parts[2]),
            a: parts[3] === undefined ? 1 : Number(parts[3]),
          };
        }

        const hexMatch = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
        if (!hexMatch) return null;
        const hex = hexMatch[1];
        if (hex.length === 3) {
          return {
            r: Number.parseInt(`${hex[0]}${hex[0]}`, 16),
            g: Number.parseInt(`${hex[1]}${hex[1]}`, 16),
            b: Number.parseInt(`${hex[2]}${hex[2]}`, 16),
            a: 1,
          };
        }
        if (hex.length === 6 || hex.length === 8) {
          return {
            r: Number.parseInt(hex.slice(0, 2), 16),
            g: Number.parseInt(hex.slice(2, 4), 16),
            b: Number.parseInt(hex.slice(4, 6), 16),
            a: hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1,
          };
        }
        return null;
      };

      const clamp = (num, min, max) => Math.max(min, Math.min(max, num));
      const normalizedChannel = (value) => clamp(Number.isFinite(value) ? value : 0, 0, 255);
      const normalizedAlpha = (value) => clamp(Number.isFinite(value) ? value : 1, 0, 1);

      const blend = (foreground, background) => {
        const fgA = normalizedAlpha(foreground.a);
        const bgA = normalizedAlpha(background.a);
        const outA = fgA + bgA * (1 - fgA);
        if (outA <= 0) return { r: 0, g: 0, b: 0, a: 0 };

        return {
          r: (normalizedChannel(foreground.r) * fgA + normalizedChannel(background.r) * bgA * (1 - fgA)) / outA,
          g: (normalizedChannel(foreground.g) * fgA + normalizedChannel(background.g) * bgA * (1 - fgA)) / outA,
          b: (normalizedChannel(foreground.b) * fgA + normalizedChannel(background.b) * bgA * (1 - fgA)) / outA,
          a: outA,
        };
      };

      const srgbToLinear = (channel) => {
        const c = normalizedChannel(channel) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };

      const luminance = (color) =>
        0.2126 * srgbToLinear(color.r) + 0.7152 * srgbToLinear(color.g) + 0.0722 * srgbToLinear(color.b);

      const contrastRatio = (fg, bg) => {
        const fgLum = luminance(fg);
        const bgLum = luminance(bg);
        const bright = Math.max(fgLum, bgLum);
        const dark = Math.min(fgLum, bgLum);
        return (bright + 0.05) / (dark + 0.05);
      };

      const toColorText = (color) =>
        `rgba(${Math.round(normalizedChannel(color.r))},` +
        `${Math.round(normalizedChannel(color.g))},` +
        `${Math.round(normalizedChannel(color.b))},` +
        `${normalizedAlpha(color.a).toFixed(3)})`;

      const isVisible = (el) => {
        let node = el;
        while (node && node instanceof Element) {
          const style = getComputedStyle(node);
          if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
            return false;
          }
          node = node.parentElement;
        }
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const fallbackBackground = (() => {
        const bodyBg = parseColor(getComputedStyle(document.body).backgroundColor);
        if (bodyBg && bodyBg.a > 0) return bodyBg;
        const htmlBg = parseColor(getComputedStyle(document.documentElement).backgroundColor);
        if (htmlBg && htmlBg.a > 0) return htmlBg;
        return { r: 255, g: 255, b: 255, a: 1 };
      })();

      const getEffectiveBackground = (el) => {
        const layers = [];
        let node = el;
        while (node && node instanceof Element) {
          const bg = parseColor(getComputedStyle(node).backgroundColor);
          if (bg && bg.a > 0) layers.push(bg);
          node = node.parentElement;
        }
        let composite = fallbackBackground;
        for (let idx = layers.length - 1; idx >= 0; idx -= 1) {
          composite = blend(layers[idx], composite);
        }
        return composite;
      };

      const violations = [];
      let sampledCount = 0;
      let failingCount = 0;
      let minRatio = Number.POSITIVE_INFINITY;
      let worstViolation = null;
      let truncated = false;
      let processedElements = 0;

      const elements = Array.from(document.querySelectorAll("body *"));
      for (const el of elements) {
        processedElements += 1;
        if (processedElements > maxDomElements) {
          truncated = true;
          break;
        }

        if (!(el instanceof HTMLElement)) continue;
        if (skipTagSet.has(el.tagName.toLowerCase())) continue;
        if (!isVisible(el)) continue;
        if (el.getClientRects().length === 0) continue;

        const directText = Array.from(el.childNodes)
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim())
          .filter(Boolean)
          .join(" ")
          .trim();
        if (!directText || !textSignalRe.test(directText)) continue;

        const fg = parseColor(getComputedStyle(el).color);
        if (!fg) continue;
        const bg = getEffectiveBackground(el);
        const ratio = contrastRatio(fg, bg);
        const roundedRatio = Number(ratio.toFixed(3));

        sampledCount += 1;
        if (sampledCount >= maxSamples) {
          truncated = true;
          break;
        }

        if (ratio < minRatio) {
          minRatio = ratio;
          worstViolation = {
            text: directText.slice(0, 140),
            ratio: roundedRatio,
            tag: el.tagName.toLowerCase(),
            class_name: (el.className ?? "").toString().slice(0, 140),
            fg: toColorText(fg),
            bg: toColorText(bg),
          };
        }

        if (ratio < minContrast) {
          failingCount += 1;
          if (violations.length < 40) {
            violations.push({
              text: directText.slice(0, 140),
              ratio: roundedRatio,
              tag: el.tagName.toLowerCase(),
              class_name: (el.className ?? "").toString().slice(0, 140),
              fg: toColorText(fg),
              bg: toColorText(bg),
            });
          }
        }
      }

      return {
        theme: document.documentElement.getAttribute("data-theme"),
        sampled_text_nodes: sampledCount,
        failing_text_nodes: failingCount,
        min_contrast_ratio: Number.isFinite(minRatio) ? Number(minRatio.toFixed(3)) : null,
        truncated,
        processed_elements: processedElements,
        max_dom_elements: maxDomElements,
        max_samples: maxSamples,
        worst_violation: worstViolation,
        violations,
      };
    },
    {
      minContrast: minimumContrast,
      maxSamples: maxSamplesPerView,
      maxDomElements: MAX_DOM_ELEMENTS_PER_VIEW,
    },
  );
}

export async function collectThemeContrastAcrossViews(page, desiredTheme, toggleLocator, onTrace = null) {
  const themeReady = await ensureTheme(page, desiredTheme, toggleLocator, onTrace);
  const navButtons = page.locator("aside nav button");
  const navCount = await navButtons.count().catch(() => 0);
  const scanCount = Math.min(navCount, SIDEBAR_VIEW_SCAN_LIMIT);
  const viewAudits = [];
  if (onTrace) await onTrace(`contrast:start:${desiredTheme}:navCount=${navCount}:scanCount=${scanCount}`);

  if (scanCount > 0) {
    for (let idx = 0; idx < scanCount; idx += 1) {
      const navButton = navButtons.nth(idx);
      const viewLabel =
        ((await navButton.textContent().catch(() => "")) ?? "").replace(/\s+/g, " ").trim() || `nav-${idx + 1}`;

      await navButton.click({ timeout: 5_000 }).catch(() => {});
      await waitForAppSettled(page, 1_500, 300);
      const viewContrast = await collectCurrentViewContrast(page, WCAG_AA_MIN_CONTRAST, MAX_TEXT_ELEMENTS_PER_VIEW);
      if (onTrace) {
        await onTrace(
          `contrast:view:${desiredTheme}:idx=${idx}:sampled=${viewContrast.sampled_text_nodes}:failed=${viewContrast.failing_text_nodes}:truncated=${viewContrast.truncated}`,
        );
      }
      viewAudits.push({
        view_index: idx,
        view_label: viewLabel,
        ...viewContrast,
      });
    }
  } else {
    const fallbackViewContrast = await collectCurrentViewContrast(
      page,
      WCAG_AA_MIN_CONTRAST,
      MAX_TEXT_ELEMENTS_PER_VIEW,
    );
    viewAudits.push({
      view_index: 0,
      view_label: "default-view",
      ...fallbackViewContrast,
    });
    if (onTrace) {
      await onTrace(
        `contrast:view:${desiredTheme}:idx=0:sampled=${fallbackViewContrast.sampled_text_nodes}:failed=${fallbackViewContrast.failing_text_nodes}:truncated=${fallbackViewContrast.truncated}`,
      );
    }
  }

  const sampledTextNodes = viewAudits.reduce((sum, view) => sum + view.sampled_text_nodes, 0);
  const failingTextNodes = viewAudits.reduce((sum, view) => sum + view.failing_text_nodes, 0);
  const isTruncated = viewAudits.some((view) => view.truncated);
  const minContrastValues = viewAudits
    .map((view) => view.min_contrast_ratio)
    .filter((ratio) => typeof ratio === "number");
  const minContrastRatio = minContrastValues.length > 0 ? Number(Math.min(...minContrastValues).toFixed(3)) : null;

  const violations = viewAudits
    .flatMap((view) =>
      view.violations.map((violation) => ({
        ...violation,
        view_label: view.view_label,
        view_index: view.view_index,
      })),
    )
    .sort((a, b) => a.ratio - b.ratio)
    .slice(0, 25);

  const pass =
    Boolean(themeReady.matched) &&
    !isTruncated &&
    sampledTextNodes > 0 &&
    failingTextNodes === 0 &&
    (minContrastRatio ?? 0) >= WCAG_AA_MIN_CONTRAST;

  return {
    requested_theme: desiredTheme,
    minimum_required_ratio: WCAG_AA_MIN_CONTRAST,
    theme_ready: themeReady,
    sampled_text_nodes: sampledTextNodes,
    failing_text_nodes: failingTextNodes,
    min_contrast_ratio: minContrastRatio,
    truncated: isTruncated,
    max_samples_per_view: MAX_TEXT_ELEMENTS_PER_VIEW,
    max_dom_elements_per_view: MAX_DOM_ELEMENTS_PER_VIEW,
    views_scanned: viewAudits.length,
    per_view: viewAudits,
    violations,
    pass,
  };
}

export async function collectScopedContrastFromRoot(rootHandle, minimumContrast, maxSamplesPerView) {
  if (!rootHandle) {
    return {
      sampled_text_nodes: 0,
      failing_text_nodes: 0,
      min_contrast_ratio: null,
      truncated: false,
      processed_elements: 0,
      max_dom_elements: MAX_DOM_ELEMENTS_PER_VIEW,
      max_samples: maxSamplesPerView,
      root_found: false,
      violations: [],
    };
  }

  return rootHandle.evaluate(
    (root, payload) => {
      const { minContrast, maxSamples, maxDomElements } = payload;
      const textSignalRe = /[A-Za-z0-9가-힣ぁ-んァ-ヶ一-龯]/;
      const skipTagSet = new Set(["script", "style", "noscript"]);

      const parseColor = (raw) => {
        if (typeof raw !== "string") return null;
        const value = raw.trim().toLowerCase();
        if (!value) return null;
        if (value === "transparent") return { r: 0, g: 0, b: 0, a: 0 };

        const rgbMatch = value.match(/^rgba?\(([^)]+)\)$/);
        if (rgbMatch) {
          const parts = rgbMatch[1].split(",").map((part) => part.trim());
          if (parts.length < 3) return null;
          return {
            r: Number(parts[0]),
            g: Number(parts[1]),
            b: Number(parts[2]),
            a: parts[3] === undefined ? 1 : Number(parts[3]),
          };
        }

        const hexMatch = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
        if (!hexMatch) return null;
        const hex = hexMatch[1];
        if (hex.length === 3) {
          return {
            r: Number.parseInt(`${hex[0]}${hex[0]}`, 16),
            g: Number.parseInt(`${hex[1]}${hex[1]}`, 16),
            b: Number.parseInt(`${hex[2]}${hex[2]}`, 16),
            a: 1,
          };
        }
        if (hex.length === 6 || hex.length === 8) {
          return {
            r: Number.parseInt(hex.slice(0, 2), 16),
            g: Number.parseInt(hex.slice(2, 4), 16),
            b: Number.parseInt(hex.slice(4, 6), 16),
            a: hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1,
          };
        }
        return null;
      };

      const clamp = (num, min, max) => Math.max(min, Math.min(max, num));
      const normalizedChannel = (value) => clamp(Number.isFinite(value) ? value : 0, 0, 255);
      const normalizedAlpha = (value) => clamp(Number.isFinite(value) ? value : 1, 0, 1);

      const blend = (foreground, background) => {
        const fgA = normalizedAlpha(foreground.a);
        const bgA = normalizedAlpha(background.a);
        const outA = fgA + bgA * (1 - fgA);
        if (outA <= 0) return { r: 0, g: 0, b: 0, a: 0 };

        return {
          r: (normalizedChannel(foreground.r) * fgA + normalizedChannel(background.r) * bgA * (1 - fgA)) / outA,
          g: (normalizedChannel(foreground.g) * fgA + normalizedChannel(background.g) * bgA * (1 - fgA)) / outA,
          b: (normalizedChannel(foreground.b) * fgA + normalizedChannel(background.b) * bgA * (1 - fgA)) / outA,
          a: outA,
        };
      };

      const srgbToLinear = (channel) => {
        const c = normalizedChannel(channel) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };

      const luminance = (color) =>
        0.2126 * srgbToLinear(color.r) + 0.7152 * srgbToLinear(color.g) + 0.0722 * srgbToLinear(color.b);

      const contrastRatio = (fg, bg) => {
        const fgLum = luminance(fg);
        const bgLum = luminance(bg);
        const bright = Math.max(fgLum, bgLum);
        const dark = Math.min(fgLum, bgLum);
        return (bright + 0.05) / (dark + 0.05);
      };

      const toColorText = (color) =>
        `rgba(${Math.round(normalizedChannel(color.r))},` +
        `${Math.round(normalizedChannel(color.g))},` +
        `${Math.round(normalizedChannel(color.b))},` +
        `${normalizedAlpha(color.a).toFixed(3)})`;

      const fallbackBackground = (() => {
        const rootBg = parseColor(getComputedStyle(root).backgroundColor);
        if (rootBg && rootBg.a > 0) return rootBg;
        const bodyBg = parseColor(getComputedStyle(document.body).backgroundColor);
        if (bodyBg && bodyBg.a > 0) return bodyBg;
        const htmlBg = parseColor(getComputedStyle(document.documentElement).backgroundColor);
        if (htmlBg && htmlBg.a > 0) return htmlBg;
        return { r: 255, g: 255, b: 255, a: 1 };
      })();

      const rootRect = root.getBoundingClientRect();
      const isVisible = (el) => {
        let node = el;
        while (node && node instanceof Element) {
          const style = getComputedStyle(node);
          if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
            return false;
          }
          if (node === root) break;
          node = node.parentElement;
        }
        if (!root.contains(el)) return false;
        const rect = el.getBoundingClientRect();
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          rect.bottom >= rootRect.top &&
          rect.top <= rootRect.bottom &&
          rect.right >= rootRect.left &&
          rect.left <= rootRect.right
        );
      };

      const getEffectiveBackground = (el) => {
        const layers = [];
        let node = el;
        while (node && node instanceof Element) {
          const bg = parseColor(getComputedStyle(node).backgroundColor);
          if (bg && bg.a > 0) layers.push(bg);
          if (node === root) break;
          node = node.parentElement;
        }
        let composite = fallbackBackground;
        for (let idx = layers.length - 1; idx >= 0; idx -= 1) {
          composite = blend(layers[idx], composite);
        }
        return composite;
      };

      const violations = [];
      let sampledCount = 0;
      let failingCount = 0;
      let minRatio = Number.POSITIVE_INFINITY;
      let worstViolation = null;
      let truncated = false;
      let processedElements = 0;

      const elements = Array.from(root.querySelectorAll("*"));
      for (const el of elements) {
        processedElements += 1;
        if (processedElements > maxDomElements) {
          truncated = true;
          break;
        }

        if (!(el instanceof HTMLElement)) continue;
        if (skipTagSet.has(el.tagName.toLowerCase())) continue;
        if (!isVisible(el)) continue;
        if (el.getClientRects().length === 0) continue;

        const directText = Array.from(el.childNodes)
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim())
          .filter(Boolean)
          .join(" ")
          .trim();
        if (!directText || !textSignalRe.test(directText)) continue;

        const fg = parseColor(getComputedStyle(el).color);
        if (!fg) continue;
        const bg = getEffectiveBackground(el);
        const ratio = contrastRatio(fg, bg);
        const roundedRatio = Number(ratio.toFixed(3));

        sampledCount += 1;
        if (sampledCount >= maxSamples) {
          truncated = true;
          break;
        }

        if (ratio < minRatio) {
          minRatio = ratio;
          worstViolation = {
            text: directText.slice(0, 140),
            ratio: roundedRatio,
            tag: el.tagName.toLowerCase(),
            class_name: (el.className ?? "").toString().slice(0, 140),
            fg: toColorText(fg),
            bg: toColorText(bg),
          };
        }

        if (ratio < minContrast) {
          failingCount += 1;
          if (violations.length < 40) {
            violations.push({
              text: directText.slice(0, 140),
              ratio: roundedRatio,
              tag: el.tagName.toLowerCase(),
              class_name: (el.className ?? "").toString().slice(0, 140),
              fg: toColorText(fg),
              bg: toColorText(bg),
            });
          }
        }
      }

      return {
        theme: document.documentElement.getAttribute("data-theme"),
        root_found: true,
        sampled_text_nodes: sampledCount,
        failing_text_nodes: failingCount,
        min_contrast_ratio: Number.isFinite(minRatio) ? Number(minRatio.toFixed(3)) : null,
        truncated,
        processed_elements: processedElements,
        max_dom_elements: maxDomElements,
        max_samples: maxSamples,
        worst_violation: worstViolation,
        violations,
      };
    },
    {
      minContrast: minimumContrast,
      maxSamples: maxSamplesPerView,
      maxDomElements: MAX_DOM_ELEMENTS_PER_VIEW,
    },
  );
}
