import { accessSync, constants, statSync } from "node:fs";

/** A copied runtime must also work away from its original installation directory.
 * For a locally linked build (for example Homebrew), set IRONCREW_TEST_NODE to
 * an official standalone Node executable when testing portable distributions.
 */
export function testNodeRuntime(environment: { IRONCREW_TEST_NODE?: string } = process.env): string {
  const runtime = environment.IRONCREW_TEST_NODE ?? process.execPath;
  try {
    if (!statSync(runtime).isFile()) throw new Error("Not a file");
    accessSync(runtime, constants.R_OK | constants.X_OK);
  } catch (cause) {
    throw new Error(
      `Test Node runtime is not a readable executable: ${JSON.stringify(runtime)}. Set IRONCREW_TEST_NODE to a valid Node 26.4.0 executable or unset it to use process.execPath.`,
      { cause },
    );
  }
  return runtime;
}
