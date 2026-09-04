/**
 * IronCrew — a browser an agent may hold without holding the operator's.
 *
 * This is a trust boundary, in the same sense as marketplace-installer.ts.
 * The dangerous part of a browser is not that it renders pages; it is that a
 * headless Chromium running as the service user inherits whatever that user
 * can reach — the local filesystem through `file:`, an internal network
 * through a hostname, and any session the profile happens to carry.
 *
 * Four rules, each of which exists because its absence is exploitable:
 *
 * 1. **The host allowlist is deny-by-default.** No `allowedHosts` means no
 *    navigation at all, not "anywhere". A browser tool that defaults to the
 *    open internet is an SSRF primitive with a nice API.
 * 2. **http and https only.** `file:` is a local file read, `data:` and
 *    `javascript:` are script execution. None of them is a web page.
 * 3. **The profile is isolated.** Never Chromium's default profile: the agent
 *    must not inherit the operator's cookies and logged-in sessions, which is
 *    exactly how "read this page" becomes "act as the operator".
 * 4. **Page text is untrusted input.** It is stripped at this boundary the
 *    same way inbound chat is, and capped, because a page can be arbitrarily
 *    long and arbitrarily adversarial.
 *
 * What actions *mean* — read, interact, or reaching outside — lives in
 * page-actions.ts, deliberately without a Playwright import so the policy can
 * be tested and read on its own.
 */

import fs from "node:fs";
import { stripControlTokens } from "../policy/untrusted-content.ts";

/** Maximum page text returned in one read. A page is not a context window. */
export const MAX_PAGE_TEXT_CHARS = 20_000;

/** Default per-action cap. A page that never settles must not hang a run. */
export const DEFAULT_ACTION_TIMEOUT_MS = 30_000;

export class BrowserToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserToolError";
  }
}

/**
 * The slice of Playwright this module uses.
 *
 * Declared structurally rather than imported so a test can satisfy it with a
 * hand-written fake — the suite must not launch Chromium, which would make it
 * slow, flaky, and dependent on a browser being installed.
 */
export interface PageLike {
  goto(url: string, opts?: { timeout?: number }): Promise<unknown>;
  innerText(selector: string, opts?: { timeout?: number }): Promise<string>;
  screenshot(opts?: { timeout?: number }): Promise<Buffer>;
  click(selector: string, opts?: { timeout?: number }): Promise<void>;
  fill(selector: string, value: string, opts?: { timeout?: number }): Promise<void>;
}

export interface BrowserLike {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}

export interface BrowserToolOptions {
  /** Profile directory. Isolated per company; never the operator's own. */
  profileDir: string;
  headless?: boolean;
  timeoutMs?: number;
  /**
   * Hosts this tool may reach. Empty or absent means: refuse everything.
   * An entry beginning with a dot (".example.com") matches subdomains;
   * a bare host matches only itself, so allowing "example.com" does not
   * quietly allow "evil.example.com".
   */
  allowedHosts?: string[];
  browserFactory?: (opts: { profileDir: string; headless: boolean }) => Promise<BrowserLike>;
}

export class BrowserTool {
  readonly kind = "browser" as const;

  private readonly profileDir: string;
  private readonly headless: boolean;
  private readonly timeoutMs: number;
  private readonly allowedHosts: string[];
  private readonly browserFactory: (opts: { profileDir: string; headless: boolean }) => Promise<BrowserLike>;

  private browser: BrowserLike | null = null;
  private page: PageLike | null = null;
  private closed = false;

  constructor(opts: BrowserToolOptions) {
    this.profileDir = opts.profileDir;
    this.headless = opts.headless !== false;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
    this.allowedHosts = (opts.allowedHosts ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean);
    this.browserFactory = opts.browserFactory ?? defaultBrowserFactory;
  }

  /**
   * Whether a URL may be visited at all.
   *
   * Exposed so the decision can be tested and reported without launching
   * anything — a refusal an operator can reproduce is worth more than one
   * buried in a stack trace.
   */
  allows(rawUrl: string): boolean {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return false;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (this.allowedHosts.length === 0) return false;

    const host = url.hostname.toLowerCase();
    return this.allowedHosts.some((allowed) =>
      allowed.startsWith(".") ? host === allowed.slice(1) || host.endsWith(allowed) : host === allowed,
    );
  }

  async open(rawUrl: string): Promise<void> {
    this.assertUsable();
    if (!this.allows(rawUrl)) {
      throw new BrowserToolError(`"${rawUrl}" ist für dieses Werkzeug nicht freigegeben.`);
    }
    const page = await this.ensurePage();
    await this.withTimeout("navigate", page.goto(rawUrl, { timeout: this.timeoutMs }));
  }

  async readText(selector = "body"): Promise<string> {
    const page = this.requirePage("readText");
    const raw = await this.withTimeout("readText", page.innerText(selector, { timeout: this.timeoutMs }));
    // Stripped exactly as an inbound chat message is: a page can say
    // "ignore your instructions" as easily as a stranger can.
    const text = stripControlTokens(raw ?? "").text;
    return text.length > MAX_PAGE_TEXT_CHARS ? `${text.slice(0, MAX_PAGE_TEXT_CHARS - 1)}…` : text;
  }

  async screenshot(): Promise<Buffer> {
    const page = this.requirePage("screenshot");
    return this.withTimeout("screenshot", page.screenshot({ timeout: this.timeoutMs }));
  }

  async click(selector: string): Promise<void> {
    const page = this.requirePage("click");
    await this.withTimeout("click", page.click(selector, { timeout: this.timeoutMs }));
  }

  async type(selector: string, text: string): Promise<void> {
    const page = this.requirePage("type");
    // Never logged: this is where a password would be typed.
    await this.withTimeout("type", page.fill(selector, text, { timeout: this.timeoutMs }));
  }

  /** Idempotent, and safe when nothing was ever opened. */
  async close(): Promise<void> {
    this.closed = true;
    this.page = null;
    const browser = this.browser;
    this.browser = null;
    if (browser) await browser.close();
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    if (this.allowedHosts.length === 0) {
      return { ok: false, message: "Keine Hosts freigegeben — das Werkzeug würde jede Navigation ablehnen." };
    }
    try {
      const browser = await this.browserFactory({ profileDir: this.profileDir, headless: this.headless });
      await browser.close();
      return { ok: true, message: `Browser startet, ${this.allowedHosts.length} Host(s) freigegeben.` };
    } catch (err) {
      // Reported, never thrown: the Settings UI asks "does this work?".
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  private assertUsable(): void {
    if (this.closed) {
      // Silently relaunching after close() would resurrect a session the
      // caller believed it had ended.
      throw new BrowserToolError("Dieses Browser-Werkzeug wurde bereits geschlossen.");
    }
  }

  private requirePage(action: string): PageLike {
    this.assertUsable();
    if (!this.page) throw new BrowserToolError(`Für "${action}" muss zuerst eine Seite geöffnet werden.`);
    return this.page;
  }

  private async ensurePage(): Promise<PageLike> {
    if (this.page) return this.page;
    fs.mkdirSync(this.profileDir, { recursive: true });
    this.browser = await this.browserFactory({ profileDir: this.profileDir, headless: this.headless });
    this.page = await this.browser.newPage();
    return this.page;
  }

  private async withTimeout<T>(action: string, work: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new BrowserToolError(`"${action}" hat das Zeitlimit von ${this.timeoutMs} ms überschritten.`)),
            this.timeoutMs,
          );
          timer.unref?.();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Launches real Chromium with a persistent, isolated profile.
 *
 * Imported lazily so that neither the test suite nor a server without the
 * browser tool configured pays for loading Playwright.
 */
async function defaultBrowserFactory(opts: { profileDir: string; headless: boolean }): Promise<BrowserLike> {
  const { chromium } = (await import("playwright")) as unknown as {
    chromium: {
      launchPersistentContext(dir: string, options: Record<string, unknown>): Promise<BrowserLike>;
    };
  };
  return chromium.launchPersistentContext(opts.profileDir, { headless: opts.headless });
}
