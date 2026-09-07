import { build } from "vite";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
const output = path.resolve("packages/tools/site-assets");
await mkdir(output, { recursive: true });
await build({
  configFile: false,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    outDir: output,
    emptyOutDir: false,
    minify: true,
    lib: { entry: "scripts/react-runtime-entry.ts", formats: ["es"], fileName: () => "react-runtime.mjs" },
  },
});
const runtime = await readFile(path.join(output, "react-runtime.mjs"));
await writeFile(
  path.join(output, "manifest.json"),
  JSON.stringify(
    { react: "19.2.7", reactDom: "19.2.7", sha256: createHash("sha256").update(runtime).digest("hex") },
    null,
    2,
  ) + "\n",
);
await writeFile(path.join(output, "LICENSE.txt"), await readFile("node_modules/react/LICENSE"));
await mkdir("dist/packages/tools/site-assets", { recursive: true });
for (const file of ["react-runtime.mjs", "manifest.json", "LICENSE.txt"])
  await writeFile(path.join("dist/packages/tools/site-assets", file), await readFile(path.join(output, file)));
