import { test, expect } from "@playwright/test";
import { execFile, fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { siteProject } from "../../packages/tools/site-build.ts";

for (const stack of ["react", "wordpress"] as const) {
  test(`${stack} delivered artifact renders styles and blocks hostile HTML and inline handlers`, async ({ page }) => {
    const directory = await mkdtemp(path.join(tmpdir(), "site-browser-security-"));
    let child: ReturnType<typeof fork> | undefined;
    try {
      const files = await siteProject(
        stack,
        `<html><head><title>Customer fixture</title><style>h1{color:rgb(12,34,56)}</style></head><body><h1>Customer content</h1><img src="/missing" onerror="window.compromised=true"><a href="jav&#x61;script:window.compromised=true" onclick="window.compromised=true">Link</a><svg onload="window.compromised=true"><animate onbegin="window.compromised=true"></animate></svg><script>window.compromised=true</script></body></html>`,
      );
      for (const [file, content] of Object.entries(files)) {
        await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
        await writeFile(path.join(directory, file), content);
      }
      await promisify(execFile)(process.execPath, ["build.mjs"], { cwd: directory });
      child = fork(path.join(directory, "server.mjs"), [], {
        env: { ...process.env, PORT: "0" },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      const [{ port }] = (await once(child, "message")) as [{ port: number }];
      const response = await page.goto(`http://127.0.0.1:${port}/`);
      expect(response!.headers()["content-security-policy"]).toContain("script-src-attr 'none'");
      await expect(page.getByRole("heading")).toHaveText("Customer content");
      await expect(page.getByRole("heading")).toHaveCSS("color", "rgb(12, 34, 56)");
      await page.getByText("Link", { exact: true }).click();
      expect(await page.evaluate(() => Object.hasOwn(window, "compromised"))).toBe(false);
      expect(await page.locator("body").innerHTML()).not.toMatch(/onerror=|onclick=|onbegin=|<svg|javascript:/i);
      // Exercise CSP independently of sanitation: a handler added after the build
      // must still fail, while the trusted local React module already rendered.
      const blocked = await page.evaluate(async () => {
        const violation = new Promise<string>((resolve) =>
          document.addEventListener("securitypolicyviolation", (event) => resolve(event.violatedDirective), {
            once: true,
          }),
        );
        const button = document.createElement("button");
        button.setAttribute("onclick", "window.compromised=true");
        document.body.append(button);
        button.click();
        return violation;
      });
      expect(blocked).toBe("script-src-attr");
      expect(await page.evaluate(() => Object.hasOwn(window, "compromised"))).toBe(false);
    } finally {
      if (child && child.exitCode === null) {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
}
