import { readFile, writeFile } from "node:fs/promises";
import { loadExecutionPort } from "./index.ts";
import { prepareProfile } from "./prepare.ts";
import type { ExecutionRequest } from "./types.ts";
const [command, ...args] = process.argv.slice(2);
try {
  if (command === "prepare") {
    const [directory, nodeDistribution, bwrapPath, cgroupRoot, phpPath] = args;
    if (!directory || !nodeDistribution || !bwrapPath || !cgroupRoot)
      throw new Error("Usage: prepare DIRECTORY NODE_DISTRIBUTION BWRAP CGROUP_ROOT [PHP]");
    const profile = await prepareProfile({ directory, nodeDistribution, bwrapPath, cgroupRoot, phpPath });
    console.log(JSON.stringify({ profilePath: profile.rootfs.replace(/\/rootfs$/, "/profile.json"), verified: false }));
  } else if (command === "attest" || command === "execute") {
    if (!args[0]) throw new Error("A profile JSON path is required");
    const port = await loadExecutionPort(args[0]);
    if (command === "attest") {
      if (args[1]) await writeFile(args[1], JSON.stringify(port.attestation, null, 2) + "\n", { mode: 0o600 });
      console.log(JSON.stringify(port.attestation));
    } else {
      if (!args[1]) throw new Error("An execution request JSON path is required");
      const request = JSON.parse(await readFile(args[1], "utf8")) as ExecutionRequest;
      console.log(JSON.stringify(await port.execute(request)));
    }
  } else throw new Error("Usage: cli.ts prepare|attest|execute ...");
} catch (error) {
  console.error(JSON.stringify({ code: error instanceof Error ? error.message : "isolation_failed" }));
  process.exitCode = 1;
}
