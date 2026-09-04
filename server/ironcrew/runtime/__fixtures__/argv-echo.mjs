#!/usr/bin/env node
/**
 * Test fixture: prints the argv it was given, then the stdin it was given.
 *
 * Used to prove that the runtime actually delivers the prompt — by flag for
 * adapters whose CLI ignores stdin, by stdin for the others. A real process,
 * spawned exactly as a real CLI would be.
 *
 * A file rather than `node -e`, because node parses its own options before a
 * script and would swallow a `-p` meant for the fixture.
 */

const args = process.argv.slice(2);

let stdinData = "";
process.stdin.on("data", (chunk) => {
  stdinData += chunk.toString("utf8");
});
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ args, stdin: stdinData }));
});
