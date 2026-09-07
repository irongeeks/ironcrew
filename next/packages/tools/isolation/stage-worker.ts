/** Explicit one-time enrollment copy inside the dedicated guest; never prints credentials. */
import { readFile, writeFile, lstat } from "node:fs/promises";
import path from "node:path";
const [source, base] = process.argv.slice(2);
if (!source || !base || !path.isAbsolute(base) || process.platform !== "linux")
  throw new Error("Guest enrollment arguments invalid");
const config = JSON.parse(await readFile(source, "utf8")) as Record<string, unknown>;
if (
  typeof config.url !== "string" ||
  new URL(config.url).protocol !== "wss:" ||
  typeof config.token !== "string" ||
  config.token.length < 32
)
  throw new Error("Authenticated WSS enrollment required");
const caFile = path.join(base, "config/ca.pem");
if (!(await lstat(caFile)).isFile()) throw new Error("WSS CA required");
await writeFile(
  path.join(base, "config/worker.json"),
  JSON.stringify(
    {
      ...config,
      caFile,
      directory: path.join(base, "state"),
      isolationProfilePath: path.join(base, "profile/profile.json"),
      capabilities: ["workspace.read", "workspace.apply_patch", "workspace.execute"],
    },
    null,
    2,
  ) + "\n",
  { mode: 0o600 },
);
