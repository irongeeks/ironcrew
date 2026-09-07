import { mkdir, readdir, copyFile } from "node:fs/promises";
import path from "node:path";
const source = "packages/tools/isolation",
  destination = "dist/packages/tools/isolation";
await mkdir(destination, { recursive: true });
for (const file of await readdir(source))
  if (/\.(sh|ps1|md)$/.test(file)) await copyFile(path.join(source, file), path.join(destination, file));
