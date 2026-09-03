import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * WCAG 2.1 contrast ratio helpers (relative luminance per WCAG).
 * Kept inline so the test has zero non-test dependencies.
 */
function hexToRgb(hex: string): [number, number, number] {
  const cleaned = hex.replace("#", "").trim();
  const full =
    cleaned.length === 3
      ? cleaned
          .split("")
          .map((c) => c + c)
          .join("")
      : cleaned;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) {
    throw new Error(`Invalid hex color: "${hex}"`);
  }
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return [r, g, b];
}

function relativeLuminance(hex: string): number {
  const channels = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  const [r, g, b] = channels as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(hexA: string, hexB: string): number {
  const la = relativeLuminance(hexA);
  const lb = relativeLuminance(hexB);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cssPath = path.resolve(__dirname, "index.part01.css");
const css = readFileSync(cssPath, "utf8");

/** Extract the light-theme block content. */
function lightBlock(): string {
  const match = css.match(/\[data-theme="light"\][^{]*\{([\s\S]*?)\n\}/);
  if (!match) throw new Error('Could not find [data-theme="light"] block in index.part01.css');
  return match[1];
}

function readVar(block: string, name: string): string {
  const re = new RegExp(`--${name}\\s*:\\s*(#[0-9a-fA-F]{3,8})\\s*;`);
  const m = block.match(re);
  if (!m) throw new Error(`Could not find variable --${name} (with hex value) in light theme block`);
  return m[1];
}

describe("light-theme WCAG AA contrast", () => {
  const block = lightBlock();
  const bgBase = readVar(block, "bg-base");
  const textPrimary = readVar(block, "text-primary");
  const textMuted = readVar(block, "text-muted");

  it("--text-muted vs --bg-base meets WCAG AA (>= 4.5:1)", () => {
    const ratio = contrastRatio(textMuted, bgBase);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it("--accent-text vs --bg-base meets WCAG AA (>= 4.5:1)", () => {
    const accentText = readVar(block, "accent-text");
    const ratio = contrastRatio(accentText, bgBase);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it("--text-primary vs --bg-base meets WCAG AAA (>= 7:1) — regression guard", () => {
    const ratio = contrastRatio(textPrimary, bgBase);
    expect(ratio).toBeGreaterThanOrEqual(7);
  });

  it("--accent-text vs --bg-base meets WCAG 1.4.11 non-text UI (>= 3:1)", () => {
    // OctoOfficeTopBar renders the accent variant as both text and as
    // border/icon-adjacent UI (active tab indicator). Guard the 3:1 floor
    // for non-text UI components per WCAG 2.1 1.4.11.
    const accentText = readVar(block, "accent-text");
    const ratio = contrastRatio(accentText, bgBase);
    expect(ratio).toBeGreaterThanOrEqual(3);
  });
});
