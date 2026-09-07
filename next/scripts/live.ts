import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ProtonPassResolver, secretRefSchema } from "../packages/integrations/src/index.ts";
import { OpenRouterClient, estimate } from "../packages/runtime/src/openrouter.ts";
const args = process.argv.slice(2).filter((a) => a !== "--");
const at = args.indexOf("--profile");
if (at < 0 || !args[at + 1]) {
  console.error("Live-Nachweis benötigt --profile <Datei> mit expliziter Testfreigabe, SecretRef und Kostenrahmen.");
  process.exitCode = 2;
} else {
  const profile = z
    .object({
      name: z.string(),
      authorized: z.literal(true),
      maxCostUsdMicros: z.string().regex(/^[1-9][0-9]*$/),
      proton: z.object({ executable: z.string(), sessionDirectory: z.string().optional() }),
      openrouter: z.object({ modelId: z.string(), secretRef: secretRefSchema }),
    })
    .strict()
    .parse(JSON.parse(await readFile(args[at + 1]!, "utf8")));
  const secret = new ProtonPassResolver({
    executable: profile.proton.executable,
    environment: {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      PATH: path.dirname(profile.proton.executable),
      ...(profile.proton.sessionDirectory ? { PROTON_PASS_SESSION_DIR: profile.proton.sessionDirectory } : {}),
    },
  });
  const client = new OpenRouterClient({
    secret: () => secret.resolve(profile.openrouter.secretRef, "Explicitly authorized IronCrew model contract test"),
  });
  const models = await client.catalog();
  const model = models.find((m) => m.id === profile.openrouter.modelId);
  if (!model) throw new Error("Configured test model is not in the current catalog");
  const request = {
    model: model.id,
    messages: [{ role: "user" as const, content: "Reply with the word IronCrew." }],
    tools: [],
    max_tokens: 16,
  };
  const reserved = estimate(model, request);
  if (BigInt(reserved) > BigInt(profile.maxCostUsdMicros))
    throw new Error("Test cost reservation exceeds profile limit");
  const evidenceDirectory = path.resolve(".var/live-evidence");
  await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
  const evidencePath = path.join(evidenceDirectory, Date.now() + ".json");
  const evidence = {
    profile: profile.name,
    modelId: model.id,
    reservedUsdMicros: reserved,
    state: "sent",
    observedAt: new Date().toISOString(),
  };
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
  try {
    const result = await client.complete(request);
    await writeFile(
      evidencePath,
      JSON.stringify(
        {
          ...evidence,
          state: result.costUsdMicros === undefined ? "usage_unreconciled" : "complete",
          providerGenerationId: result.id,
          costUsdMicros: result.costUsdMicros,
          hasNonemptyResponse: !!result.message.content?.trim(),
        },
        null,
        2,
      ),
    );
    if (result.costUsdMicros === undefined || !result.message.content?.trim()) process.exitCode = 1;
    console.info(
      JSON.stringify({
        evidencePath,
        providerGenerationId: result.id,
        costUsdMicros: result.costUsdMicros,
        passed: !process.exitCode,
      }),
    );
  } catch {
    await writeFile(
      evidencePath,
      JSON.stringify({ ...evidence, state: "interrupted", usage: "unreconciled" }, null, 2),
    );
    console.error("Live-Test unterbrochen; reservierte Kosten bleiben ungeklärt. " + evidencePath);
    process.exitCode = 1;
  }
}
