import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, lstat, open } from "node:fs/promises";
import { constants } from "node:fs";
import type { Duplex } from "node:stream";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { chromium } from "playwright-core";
import { digest, ToolError } from "./workspace.ts";
import { hashFile } from "../operations/src/common.ts";
export const browserConfigurationSchema = z
  .object({ executable: z.string().min(1), executableSha256: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
export type BrowserConfiguration = z.infer<typeof browserConfigurationSchema>;
export async function readBrowserConfiguration(directory: string): Promise<BrowserConfiguration | undefined> {
  const file = path.join(directory, "browser-configuration.json");
  let stat;
  try {
    stat = await lstat(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size > 16000 ||
    (process.platform !== "win32" && stat.mode & 0o022)
  )
    throw new ToolError("browser_configuration_unsafe");
  const handle = await open(file, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
  try {
    const fresh = await handle.stat();
    if (fresh.dev !== stat.dev || fresh.ino !== stat.ino || fresh.size > 16000)
      throw new ToolError("browser_configuration_changed");
    return browserConfigurationSchema.parse(JSON.parse(await handle.readFile("utf8")));
  } finally {
    await handle.close();
  }
}
export const browserInspectInputSchema = z
  .object({
    artifactPreviewId: z.uuid(),
    expectedPackageSha256: z.string().regex(/^[a-f0-9]{64}$/),
    viewport: z.enum(["desktop", "mobile"]).default("desktop"),
  })
  .strict();
export const previewOrigin = "https://ironcrew-preview.invalid";
export type PreviewSnapshot = {
  entry: string;
  assets: ReadonlyMap<string, { content: Buffer; headers: Record<string, string> }>;
};
/** Local rejection only: CONNECT sockets never become outbound tunnels. */
export function createBrowserDenyProxy() {
  const sockets = new Set<Duplex>();
  const server = createServer((_req, res) => {
    res.writeHead(403);
    res.end();
  });
  server.on("connect", (_req, socket) => {
    sockets.add(socket);
    // CONNECT transfers ownership out of HTTP; peers can reset while reading the denial.
    socket.on("error", () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
  });
  return {
    server,
    async close() {
      // closeAllConnections excludes sockets taken over by CONNECT.
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
/** No network-backed navigation, inherited user profile, model JS or custom launch flags. */
export async function inspectPreview(
  configuration: BrowserConfiguration,
  snapshot: PreviewSnapshot,
  viewport: "desktop" | "mobile",
) {
  const config = browserConfigurationSchema.parse(configuration);
  if (!path.isAbsolute(config.executable)) throw new ToolError("browser_configuration_unsafe");
  const binary = await lstat(config.executable).catch(() => undefined);
  if (!binary?.isFile() || binary.isSymbolicLink() || (await hashFile(config.executable)) !== config.executableSha256)
    throw new ToolError("browser_binary_unverified");
  if (process.platform === "linux" && process.getuid?.() === 0)
    throw new ToolError("browser_sandbox_requires_non_root");
  const directory = await mkdtemp(path.join(tmpdir(), "ironcrew-browser-"));
  const denyProxy = createBrowserDenyProxy();
  const proxy = denyProxy.server;
  await new Promise<void>((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", resolve);
  });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    await mkdir(path.join(directory, "home"), { mode: 0o700 });
    browser = await chromium.launch({
      executablePath: config.executable,
      headless: true,
      chromiumSandbox: true,
      timeout: 15000,
      env: {
        HOME: path.join(directory, "home"),
        TMPDIR: directory,
        TEMP: directory,
        TMP: directory,
        ...(process.platform === "win32" ? { SYSTEMROOT: process.env.SYSTEMROOT ?? "C:\\Windows" } : {}),
      },
      proxy: { server: `http://127.0.0.1:${(proxy.address() as { port: number }).port}`, bypass: "<-loopback>" },
      args: [
        "--enable-automation",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-domain-reliability",
        "--disable-sync",
        "--disable-quic",
        "--no-first-run",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
        "--renderer-process-limit=2",
        "--js-flags=--max-old-space-size=128",
      ],
    });
    timer = setTimeout(() => {
      timedOut = true;
      void browser?.close();
    }, 20000);
    const session = await browser.newBrowserCDPSession();
    const command = await session.send("Browser.getBrowserCommandLine");
    if (
      command.arguments.some((a: string) =>
        /^--(?:no-sandbox|disable-setuid-sandbox|disable-seccomp-filter-sandbox|disable-namespace-sandbox|disable-gpu-sandbox|single-process|in-process-gpu|disable-web-security)(?:=|$)/.test(
          a,
        ),
      )
    )
      throw new ToolError("browser_sandbox_disabled");
    await session.detach();
    const context = await browser.newContext({
      viewport: viewport === "mobile" ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
      deviceScaleFactor: 1,
      serviceWorkers: "block",
      acceptDownloads: false,
      permissions: [],
      javaScriptEnabled: true,
    });
    const blocked = new Map<string, number>();
    const note = (kind: string) => blocked.set(kind, (blocked.get(kind) ?? 0) + 1);
    await context.routeWebSocket("**", (socket) => {
      note("websocket");
      socket.close();
    });
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const asset = snapshot.assets.get(url.pathname);
      if (
        url.origin !== previewOrigin ||
        url.search ||
        url.hash ||
        request.method() !== "GET" ||
        !asset ||
        (request.isNavigationRequest() && request.frame().parentFrame())
      ) {
        note("request");
        await route.abort("blockedbyclient");
        return;
      }
      await route.fulfill({ status: 200, body: asset.content, headers: asset.headers });
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", () => {
      if (errors.length < 20) errors.push("page_script_error");
    });
    context.on("page", (other) => {
      if (other !== page) void other.close();
    });
    const run = async () => {
      await page.goto(previewOrigin + snapshot.entry, { waitUntil: "load", timeout: 10000 });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(100);
      const dom = await page.evaluate(() => {
        const elements = Array.from(document.querySelectorAll("body *")).slice(0, 500);
        const slice = (value: string | null, max = 300) => (value ?? "").slice(0, max);
        return {
          title: slice(document.title),
          lang: slice(document.documentElement.lang, 30),
          origin: globalThis.origin,
          width: innerWidth,
          height: innerHeight,
          scrollWidth: document.documentElement.scrollWidth,
          nodes: elements.map((el) => ({
            tag: el.tagName.toLowerCase(),
            text: slice(
              Array.from(el.childNodes)
                .filter((n) => n.nodeType === Node.TEXT_NODE)
                .map((n) => n.textContent)
                .join(" "),
            ),
            role: slice(el.getAttribute("role"), 80),
            alt: slice(el.getAttribute("alt")),
            heading: /^H[1-6]$/.test(el.tagName),
          })),
          imagesMissingAlt: Array.from(document.images).filter((img) => !img.hasAttribute("alt")).length,
          imagesFailed: Array.from(document.images).filter((img) => !img.complete || img.naturalWidth === 0).length,
          cookiesEmpty: (() => {
            try {
              return document.cookie === "";
            } catch {
              return true;
            }
          })(),
          storageBlocked: (() => {
            try {
              localStorage.setItem("probe", "blocked");
              return false;
            } catch {
              return true;
            }
          })(),
          domTruncated: document.querySelectorAll("body *").length > 500,
        };
      });
      const screenshot = await page.screenshot({ type: "png", fullPage: false, animations: "disabled", timeout: 5000 });
      if (screenshot.length > 8 * 1024 * 1024) throw new ToolError("browser_evidence_limit");
      if (dom.origin !== "null" || !dom.cookiesEmpty || !dom.storageBlocked)
        throw new ToolError("browser_preview_isolation_failed");
      return {
        screenshot,
        dom,
        screenshotSha256: digest(screenshot),
        browserVersion: browser!.version(),
        executableSha256: config.executableSha256,
        sandboxEnabled: true as const,
        blockedRequests: Object.fromEntries(blocked),
        errors,
        checks: {
          titlePresent: !!dom.title.trim(),
          languagePresent: !!dom.lang.trim(),
          headingPresent: dom.nodes.some((n) => n.heading),
          noHorizontalOverflow: dom.scrollWidth <= dom.width,
          allImagesHaveAlt: dom.imagesMissingAlt === 0,
          imagesLoaded: dom.imagesFailed === 0,
          opaqueOrigin: dom.origin === "null",
          noSessionStorage: dom.storageBlocked && dom.cookiesEmpty,
        },
      };
    };
    return await run();
  } catch (error) {
    if (timedOut) throw new ToolError("browser_inspection_timeout");
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    await browser?.close();
    await denyProxy.close();
    await rm(directory, { recursive: true, force: true });
  }
}
