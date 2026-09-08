import { it, expect } from "vitest";
import { execFile, fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { siteProject } from "../../packages/tools/site-build.ts";
import { safeSiteHtml, siteResponseSecurityPolicy } from "../../packages/tools/site-safety.ts";

const attacks = `<html><head><title id="page-title">Safe title</title><meta http-equiv="refresh" content="0;url=https://evil.invalid"><style id="theme">h1{color:rgb(12,34,56)}</style></head><body class="dark" style="background: #111" onload="alert(1)">
<h1 id="proof" style="padding: 4px">Preserved content</h1><img src="https://example.org/image.png" alt="Preserved image" onerror="alert(1)">
<a href="jav&#x61;script:alert(1)" onclick="alert(1)">Bad link</a><a href="java&#10;script:alert(1)">Control</a><a href="data:text/html,evil">Data</a>
<a href="mailto:hello@example.org">Mail</a><a href="/contact">Contact</a><a href="tel:+4930123456">Phone</a>
<svg><animate onbegin="alert(1)"></animate><foreignObject><img src=x onerror="alert(1)"></foreignObject></svg>
<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=alert(1)>"></math>
<iframe srcdoc="<script>alert(1)</script>"></iframe><object data="evil"></object><embed src="evil"><base href="https://evil.invalid">
<form action="https://evil.invalid"><button formaction="javascript:alert(1)" onclick="alert(1)">No submit</button></form>
<img srcset="javascript:alert(1) 1x, https://example.org/safe.png 2x"><video poster="javascript:alert(1)"></video><script>alert(1)</script>
<!-- wp:shortcode -->[unsafe]<!-- /wp:shortcode -->
</body></html>`;

it("sanitizes encoded URLs, attributes, foreign namespaces and embedded documents while preserving design data", () => {
  const { document, body, styles } = safeSiteHtml(attacks);
  expect(body).toContain('id="proof" style="padding:4px"');
  expect(body).toContain('src="https://example.org/image.png"');
  expect(body).toContain('href="mailto:hello@example.org"');
  expect(body).toContain('href="/contact"');
  expect(body).toContain('href="tel:+4930123456"');
  expect(document).toContain('<body class="dark" style="background:#111">');
  expect(document).toContain("<title>Safe title</title>");
  expect(styles).toContain("h1{color:rgb(12,34,56)}");
  expect(body).not.toMatch(
    /\bon\w+\s*=|javascript:|data:text|<\/?(?:svg|math|script|iframe|object|embed|base|form)\b|srcdoc=|formaction=|<!--/i,
  );
  expect(document).not.toContain('http-equiv="refresh"');
  expect(document).toContain('http-equiv="Content-Security-Policy"');
  expect(safeSiteHtml(document).body).toBe(body);
});

it.each(["react", "wordpress"] as const)(
  "builds and serves the sanitized %s artifact with production CSP",
  async (stack) => {
    const directory = await mkdtemp(path.join(tmpdir(), "site-security-"));
    let child: ReturnType<typeof fork> | undefined;
    try {
      const files = await siteProject(stack, attacks);
      for (const [file, content] of Object.entries(files)) {
        await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
        await writeFile(path.join(directory, file), content);
      }
      await promisify(execFile)(process.execPath, ["build.mjs"], { cwd: directory });
      const artifact = await readFile(
        path.join(
          directory,
          stack === "react" ? "dist/concept.mjs" : "dist/ironcrew-customer-site/templates/index.html",
        ),
        "utf8",
      );
      expect(artifact).not.toMatch(/\bon\w+\s*=|javascript:|<svg|<iframe|<script/i);
      expect(artifact).toContain("Preserved content");
      if (stack === "wordpress") {
        expect(files["theme/functions.php"]).toContain("add_action('send_headers'");
        expect(files["theme/functions.php"]).toContain(siteResponseSecurityPolicy);
        expect(files["theme/functions.php"]).toContain("if (!is_admin())");
      }
      // Canonical containment must work when dist itself is a directory link.
      // Junctions do not need Windows symlink privileges. The old string-prefix
      // comparison rejected every file here (and differently cased Windows roots).
      const output = path.join(directory, "built-output");
      await rename(path.join(directory, "dist"), output);
      await symlink(output, path.join(directory, "dist"), "junction");
      const outside = path.join(directory, "private");
      await mkdir(outside);
      await writeFile(path.join(outside, "secret.txt"), "must-not-be-served");
      await symlink(outside, path.join(output, "escape"), "junction");
      child = fork(path.join(directory, "server.mjs"), [], {
        env: { ...process.env, PORT: "0" },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      const [{ port }] = (await once(child, "message")) as [{ port: number }];
      const response = await fetch(`http://127.0.0.1:${port}/`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-security-policy")).toBe(siteResponseSecurityPolicy);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await response.text()).toContain('http-equiv="Content-Security-Policy"');
      for (const route of ["/%2e%2e%2fprivate/secret.txt", "/escape/secret.txt", "/%2e%2e%5cprivate%5csecret.txt"]) {
        const denied = await fetch(`http://127.0.0.1:${port}${route}`);
        expect(denied.status).toBe(404);
        expect(await denied.text()).not.toContain("must-not-be-served");
      }
      if (stack === "react")
        expect((await fetch(`http://127.0.0.1:${port}/app.mjs`)).headers.get("content-type")).toContain(
          "text/javascript",
        );
    } finally {
      if (child && child.exitCode === null) {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
);
