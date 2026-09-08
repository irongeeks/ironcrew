import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ProtonPassResolver, secretRefSchema } from "../../packages/integrations/src/secrets.ts";
import { createFixtureLauncher } from "../fixtures/launcher.ts";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "ironcrew-proton-argv-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

it.each(["proton-pass", "protonpass"])(
  "passes %s references literally through an executable with strict option parsing",
  async (provider) => {
    const recorded = path.join(directory, "received.json");
    const executable = await createFixtureLauncher(
      directory,
      "pass-cli",
      `import { parseArgs } from 'node:util';
import { writeFileSync } from 'node:fs';
if (process.argv[2] === '--version') {
  console.log('Proton Pass CLI 2.3.2 (ac04625)');
} else {
  // Like clap, strict parseArgs rejects a separate option value beginning with '-'.
  const parsed = parseArgs({ args: process.argv.slice(4), strict: true,
    options: { 'share-id': { type: 'string' }, 'item-id': { type: 'string' }, field: { type: 'string' } } });
  if (process.argv[2] !== 'item' || process.argv[3] !== 'view') process.exit(2);
  writeFileSync(${JSON.stringify(recorded)}, JSON.stringify({ values: parsed.values,
    session: process.env.PROTON_PASS_SESSION_DIR, forbidden: process.env.DO_NOT_FORWARD }));
  process.stdout.write('  fixture-secret = ü  \\n');
}
`,
    );
    const ref = secretRefSchema.parse({
      provider,
      shareId: "-abc-_123=",
      itemId: "--item_456==",
      field: '- API Schlüssel = "quoted"; $(echo injected) & %PATH%',
    });
    // Prove this executable catches the original regression, rather than accepting all argv.
    await expect(promisify(execFile)(executable, ["item", "view", "--share-id", ref.shareId])).rejects.toMatchObject({
      code: 1,
    });
    const session = path.join(directory, "session with spaces = ü");
    const resolver = new ProtonPassResolver({
      executable,
      environment: { PROTON_PASS_SESSION_DIR: session, DO_NOT_FORWARD: "private", SYSTEMROOT: process.env.SYSTEMROOT },
    });
    await expect(resolver.resolve(ref, "argv regression")).resolves.toBe("  fixture-secret = ü  ");
    expect(JSON.parse(await readFile(recorded, "utf8"))).toEqual({
      values: { "share-id": ref.shareId, "item-id": ref.itemId, field: ref.field },
      session,
    });
  },
);

it("does not expose subprocess stdout, stderr or reference values on failure", async () => {
  const secret = "DO-NOT-EXPOSE-PROTON-SECRET";
  const executable = await createFixtureLauncher(
    directory,
    "pass-cli-error",
    `if (process.argv[2] === '--version') console.log('Proton Pass CLI 2.3.2 (ac04625)');
else { process.stdout.write(${JSON.stringify(secret)}); process.stderr.write(process.argv.join(' ')); process.exit(2); }
`,
  );
  const resolver = new ProtonPassResolver({ executable, environment: { SYSTEMROOT: process.env.SYSTEMROOT } });
  await expect(
    resolver.resolve(
      { provider: "proton-pass", shareId: "-private-share", itemId: "-private-item", field: secret },
      "failure regression",
    ),
  ).rejects.toMatchObject({
    code: "auth",
    message: "Proton-Pass-Zugriff fehlgeschlagen. Sitzung, Ablauf und Rechte prüfen.",
  });
});
