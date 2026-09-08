import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { digest, ToolError } from "./workspace.ts";
import { isVerifiedExecutionPort, type ExecutionPort, type ExecutionContext } from "./isolation/index.ts";
import { safeSiteHtml, sitePolicyMeta, siteResponseSecurityPolicy } from "./site-safety.ts";
export type SiteStack = "react" | "wordpress";
const assets = fileURLToPath(new URL("./site-assets/", import.meta.url));
const server = `import {createServer} from 'node:http';import {readFile,realpath} from 'node:fs/promises';import path from 'node:path';import {fileURLToPath} from 'node:url';if(process.version!=='v26.4.0')throw new Error('Node 26.4.0 required');const root=path.resolve(fileURLToPath(new URL('./dist/',import.meta.url)));const types={'.html':'text/html; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json'};const app=createServer(async(req,res)=>{try{const relative=decodeURIComponent(new URL(req.url,'http://localhost').pathname).replace(/^\\/+/, '')||'index.html';const file=await realpath(path.resolve(root,relative));if(!file.startsWith(root+path.sep))throw new Error('path');res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','X-Content-Type-Options':'nosniff','Content-Security-Policy':${JSON.stringify(siteResponseSecurityPolicy)}});res.end(await readFile(file));}catch{res.writeHead(404);res.end();}}).listen(Number(process.env.PORT||3000),'127.0.0.1',()=>process.send?.({port:app.address().port}));\n`;
export async function siteProject(stack: SiteStack, html: string): Promise<Record<string, string>> {
  if (stack === "wordpress" && /<\?/.test(html)) throw new ToolError("php_in_concept_denied");
  const safe = safeSiteHtml(html);
  const files: Record<string, string> = {};
  if (stack === "react") {
    const manifest = JSON.parse(await readFile(path.join(assets, "manifest.json"), "utf8")) as {
      sha256: string;
      react: string;
      reactDom: string;
    };
    const runtime = await readFile(path.join(assets, "react-runtime.mjs"), "utf8");
    if (manifest.react !== "19.2.7" || manifest.reactDom !== "19.2.7" || digest(runtime) !== manifest.sha256)
      throw new ToolError("react_runtime_changed");
    files["vendor/react-runtime.mjs"] = runtime;
    files["vendor/LICENSE.txt"] = await readFile(path.join(assets, "LICENSE.txt"), "utf8");
    files["vendor/manifest.json"] = JSON.stringify(manifest, null, 2) + "\n";
    files["src/concept.mjs"] = `export default ${JSON.stringify(safe.document)};\n`;
    files["src/app.mjs"] =
      `import {createElement,createRoot} from './vendor/react-runtime.mjs';import concept from './concept.mjs';const source=new DOMParser().parseFromString(concept,'text/html');document.title=source.title||'Website';for(const attr of source.body.attributes)document.body.setAttribute(attr.name,attr.value);for(const style of source.head.querySelectorAll('style'))document.head.append(style.cloneNode(true));function App(){return createElement('div',{dangerouslySetInnerHTML:{__html:source.body.innerHTML}});}createRoot(document.getElementById('root')).render(createElement(App));\n`;
    files["public/index.html"] =
      `<!doctype html><html lang="de"><head><meta charset="utf-8">${sitePolicyMeta}<meta name="viewport" content="width=device-width,initial-scale=1"><title>Website</title></head><body><div id="root"></div><script type="module" src="./app.mjs"></script></body></html>\n`;
    files["build.mjs"] =
      `import {mkdir,copyFile,readFile} from 'node:fs/promises';import {createHash} from 'node:crypto';if(process.version!=='v26.4.0')throw new Error('Node26.4.0 required');const m=JSON.parse(await readFile('vendor/manifest.json','utf8'));if(createHash('sha256').update(await readFile('vendor/react-runtime.mjs')).digest('hex')!==m.sha256)throw new Error('Vendor hash mismatch');await mkdir('dist/vendor',{recursive:true});for(const [a,b] of [['public/index.html','dist/index.html'],['src/app.mjs','dist/app.mjs'],['src/concept.mjs','dist/concept.mjs'],['vendor/react-runtime.mjs','dist/vendor/react-runtime.mjs'],['vendor/LICENSE.txt','dist/vendor/LICENSE.txt']])await copyFile(a,b);console.log('React offline build complete');\n`;
    files["server.mjs"] = server;
    files["package.json"] =
      JSON.stringify(
        {
          name: "ironcrew-customer-site",
          private: true,
          type: "module",
          engines: { node: "26.4.0" },
          scripts: { build: "node build.mjs", start: "node server.mjs" },
        },
        null,
        2,
      ) + "\n";
    files["README.md"] =
      "# React-Selbsthosting\n\nNode 26.4.0. `node build.mjs` baut ohne Netz und ohne Paketinstallation; `node server.mjs` startet auf 127.0.0.1:3000 (PORT konfigurierbar). React und React DOM 19.2.7 sind samt MIT-Lizenz und SHA-256 vendort. `src/app.mjs` enthält die React-Komponente, `src/concept.mjs` den ausgewählten Entwurf als Daten. Ergänzungen erfolgen als JavaScript-Module mit createElement; JSX benötigt einen zusätzlich geprüften Compiler.\n\nKonzept-HTML wird vor der Ausgabe bereinigt; Skripte, Eventattribute, SVG/MathML und aktive Einbettungen werden entfernt. Inline-CSS und HTTPS-Bilder bleiben erlaubt. CSP wird im HTML und vom Server geliefert. Eigene Interaktivität muss als geprüftes lokales Modul ergänzt werden.\n\nVor externem Betrieb TLS-Reverse-Proxy konfigurieren. Neue Version separat bauen und prüfen, Dienst stoppen, auf neue Version wechseln, starten und HTTPS/Funktion prüfen. Alte Version für Rollback behalten. Die Buildprüfung bestätigt weder TLS noch einen Livebetrieb.\n";
  } else {
    const { body, styles } = safe;
    files["theme/style.css"] =
      "/*\nTheme Name: IronCrew Customer Site\nVersion: 1.0.0\nRequires at least: 7.0\nLicense: GPL-2.0-or-later\nText Domain: ironcrew-customer-site\n*/\n" +
      styles;
    files["theme/theme.json"] =
      JSON.stringify(
        { version: 3, settings: { appearanceTools: true, layout: { contentSize: "1200px", wideSize: "1440px" } } },
        null,
        2,
      ) + "\n";
    files["theme/templates/index.html"] =
      "<!-- wp:html -->\n" +
      (safe.bodyAttributes ? `<div${safe.bodyAttributes}>${body}</div>` : body) +
      "\n<!-- /wp:html -->\n";
    files["theme/functions.php"] =
      `<?php\nif (!defined('ABSPATH')) { exit; }\nadd_action('send_headers', function () { if (!is_admin()) { header(${JSON.stringify("Content-Security-Policy: ")} . ${JSON.stringify(siteResponseSecurityPolicy)}); } });\nadd_action('wp_enqueue_scripts', function () { wp_enqueue_style('ironcrew-customer-site', get_stylesheet_uri(), array(), '1.0.0'); });\n`;
    files["preview/index.html"] = safe.document;
    files["server.mjs"] = server;
    files["build.mjs"] =
      `import {mkdir,cp,readFile} from 'node:fs/promises';if(process.version!=='v26.4.0')throw new Error('Node26.4.0 required');const theme=JSON.parse(await readFile('theme/theme.json','utf8'));if(theme.version!==3)throw new Error('Theme schema');for(const file of ['theme/style.css','theme/templates/index.html','theme/functions.php'])if(!(await readFile(file,'utf8')).trim())throw new Error('Empty theme file');await mkdir('dist',{recursive:true});await cp('theme','dist/ironcrew-customer-site',{recursive:true});await cp('preview/index.html','dist/index.html');console.log('WordPress block theme packaged');\n`;
    files["README.md"] =
      "# WordPress-Blocktheme\n\nZiel: WordPress 7.0.4. `php -l theme/functions.php` prüft PHP-Syntax, `node build.mjs` mit Node 26.4.0 erstellt `dist/ironcrew-customer-site`. Diesen Themeordner in einer eigenen WordPress-Installation nach `wp-content/themes/ironcrew-customer-site` kopieren und über Design → Themes aktivieren. `dist/index.html` ist eine statische Entwurfsvorschau; sie bestätigt keinen laufenden WordPress-Server.\n\nKonzept-HTML wird vor der Ausgabe bereinigt; Skripte, Eventattribute, SVG/MathML und aktive Einbettungen werden entfernt. Die statische Vorschau enthält eine CSP und kann mit `node server.mjs` nach dem Build gestartet werden. Das Theme setzt die CSP auf öffentlichen WordPress-Seiten; Inline-Skripte und Formulare sind gesperrt, Adminseiten bleiben ausgenommen. Zusätzliche Plugins und geprüfte Interaktivität benötigen eine separat geprüfte CSP-Anpassung.\n\nDatenbank, WordPress-Kern, PHP-Runtime, TLS, Backup und Zugangsdaten werden vom eigenen Hostingprofil bereitgestellt. Vor Aktivierung Datenbank und bisheriges Theme sichern. Update: neues geprüftes Theme separat bereitstellen, Sicherung anlegen, Themeversion wechseln und Startseite/Unterseiten/Admin prüfen. Rollback: vorheriges Theme wieder aktivieren, erforderlichenfalls Datenbanksicherung wiederherstellen. Zugangsdaten gehören ausschließlich in den Secretstore.\n";
  }
  return files;
}
export async function buildSiteProject(
  workspaceRoot: string,
  stack: SiteStack,
  port: ExecutionPort,
  context?: ExecutionContext,
) {
  if (!isVerifiedExecutionPort(port)) throw new ToolError("isolation_attestation_required");
  const php =
    stack === "wordpress"
      ? await port.execute({ workspaceRoot, argv: ["php", "-l", "theme/functions.php"], outputPaths: [], context })
      : undefined;
  if (php && php.exitCode !== 0) throw new ToolError("wordpress_php_validation_failed");
  const result = await port.execute({ workspaceRoot, argv: ["node", "build.mjs"], outputPaths: ["dist"], context });
  if (result.exitCode !== 0 || !result.outputHashes["dist/index.html"]) throw new ToolError("website_build_failed");
  for (const [relative, sha256] of Object.entries(result.outputHashes)) {
    if (!relative.startsWith("dist/") || relative.includes("..") || path.isAbsolute(relative))
      throw new ToolError("website_build_output_invalid");
    const content = await readFile(path.join(result.outputDirectory, relative));
    if (digest(content) !== sha256) throw new ToolError("website_build_output_changed");
    await mkdir(path.dirname(path.join(workspaceRoot, relative)), { recursive: true, mode: 0o700 });
    await writeFile(path.join(workspaceRoot, relative), content, { flag: "wx", mode: 0o600 });
  }
  return { result, php };
}
