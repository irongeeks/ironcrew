/** Explicit configuration transfer inside the guest. Existing company state is preserved. */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { configSchema } from "../../../apps/control/configuration.ts";
const [source, base] = process.argv.slice(2);
if (!source || !base || !path.isAbsolute(base) || process.platform !== "linux")
  throw new Error("Guest control arguments invalid");
const config = configSchema.parse({
  ...JSON.parse(await readFile(source, "utf8")),
  isolationProfilePath: path.join(base, "profile/profile.json"),
});
await writeFile(path.join(base, "control/configuration.json"), JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
