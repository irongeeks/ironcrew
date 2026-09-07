/* global window */
/** Render the exact bundled GLBs into local portrait PNGs; no external images or generated likeness service. */
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { chromium } from "@playwright/test";
const publicDirectory = new URL("../public/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("crew/manifest.json", publicDirectory), "utf8"));
const threeDirectory = new URL("../../../node_modules/three/", import.meta.url);
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const files = {
    "/three.js": new URL("build/three.module.js", threeDirectory),
    "/three.core.js": new URL("build/three.core.js", threeDirectory),
    "/GLTFLoader.js": new URL("examples/jsm/loaders/GLTFLoader.js", threeDirectory),
    "/utils/SkeletonUtils.js": new URL("examples/jsm/utils/SkeletonUtils.js", threeDirectory),
    "/utils/BufferGeometryUtils.js": new URL("examples/jsm/utils/BufferGeometryUtils.js", threeDirectory),
  };
  try {
    if (url.pathname === "/") {
      res.setHeader("Content-Type", "text/html");
      res.end(`<!doctype html><html><head><style>html,body{margin:0;background:transparent}canvas{display:block}</style><script type="importmap">{"imports":{"three":"/three.js"}}</script></head><body><script type="module">
import * as T from 'three'; import { GLTFLoader } from '/GLTFLoader.js';
const renderer = new T.WebGLRenderer({antialias:true, alpha:true, preserveDrawingBuffer:true}); renderer.setSize(320,420); renderer.setPixelRatio(1); renderer.setClearColor(0x000000,0); renderer.outputColorSpace=T.SRGBColorSpace; document.body.append(renderer.domElement);
const scene = new T.Scene(); scene.add(new T.HemisphereLight(0xdce5ed,0x625442,2.4)); const key=new T.DirectionalLight(0xffe2bc,3); key.position.set(3,4,4); scene.add(key); const rim=new T.DirectionalLight(0x91a6b6,2);rim.position.set(-3,3,-3);scene.add(rim);
const camera=new T.OrthographicCamera(-.76,.76,1,-1,.1,20); camera.position.set(2,1.4,8); camera.lookAt(0,1,0);
let current; window.renderCrew=async(url)=>{if(current)scene.remove(current);current=(await new GLTFLoader().loadAsync(url)).scene;scene.add(current);renderer.render(scene,camera);return renderer.domElement.toDataURL('image/png');}; window.ready=true;
</script></body></html>`);
      return;
    }
    const file =
      files[url.pathname] ??
      (manifest.models.some((model) => model.url === url.pathname)
        ? new URL(url.pathname.slice(1), publicDirectory)
        : undefined);
    if (!file) {
      res.writeHead(404).end();
      return;
    }
    res.setHeader("Content-Type", url.pathname.endsWith(".glb") ? "model/gltf-binary" : "application/javascript");
    res.end(await readFile(file));
  } catch {
    res.writeHead(500).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 320, height: 420 } });
  page.on("pageerror", (error) => console.error(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") console.error(message.text());
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.ready === true);
  const portraits = [];
  for (const model of manifest.models) {
    const dataUrl = await page.evaluate((url) => window.renderCrew(url), model.url);
    const bytes = Buffer.from(dataUrl.split(",")[1], "base64");
    const url = `/crew/${model.id}.png`;
    await writeFile(new URL(url.slice(1), publicDirectory), bytes);
    portraits.push({
      seedKey: model.seedKey,
      url,
      sourceGlbSha256: model.sha256,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byteLength: bytes.length,
    });
  }
  await writeFile(
    new URL("crew/portraits.json", publicDirectory),
    JSON.stringify({ version: 1, provenance: "local Three.js render of bundled GLBs", portraits }, null, 2) + "\n",
  );
  await mkdir(new URL("../../../docs/test-evidence/", import.meta.url), { recursive: true });
  const cards = await Promise.all(
    portraits.map(
      async (portrait, index) =>
        `<figure><img src="data:image/png;base64,${(await readFile(new URL(portrait.url.slice(1), publicDirectory))).toString("base64")}"><figcaption>${manifest.models[index].id.replaceAll("-", " ")}</figcaption></figure>`,
    ),
  );
  await page.setViewportSize({ width: 1500, height: 1050 });
  await page.setContent(
    `<html><head><style>body{background:#192226;color:#e8e4d6;font-family:system-ui;margin:24px}main{display:grid;grid-template-columns:repeat(5,1fr);gap:20px}figure{margin:0;background:#263137;border:1px solid #455153}img{display:block;width:100%;height:420px;object-fit:contain}figcaption{padding:12px;text-transform:capitalize;font-size:17px;border-top:1px solid #455153}h1{font-size:25px;font-weight:500}</style></head><body><h1>IronCrew · Neun stilisierte Charaktere / GLB Revision 2</h1><main>${cards.join("")}</main></body></html>`,
  );
  await page.screenshot({
    path: new URL("../../../docs/test-evidence/crew-character-contact-sheet.png", import.meta.url).pathname,
    fullPage: true,
  });
  console.log(`Rendered ${portraits.length} local GLB portraits and contact sheet.`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
