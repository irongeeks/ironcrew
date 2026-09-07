/** Private helper launched with the data owner's uid/gid. It never controls services or releases. */
import path from "node:path";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { Repository } from "../../packages/persistence/src/index.ts";
import { createBackup } from "../../packages/operations/src/backup.ts";
const chunks = [];
let bytes = 0;
for await (const chunk of process.stdin) {
  bytes += chunk.length;
  if (bytes > 2_000_000) throw new Error("Backup input exceeds limit");
  chunks.push(chunk);
}
const input = z
  .object({
    dataDirectory: z.string().refine(path.isAbsolute),
    outputDirectory: z.string().refine(path.isAbsolute),
    ageExecutable: z.string().refine(path.isAbsolute),
    recipient: z.string(),
    appVersion: z.string(),
  })
  .strict()
  .parse(JSON.parse(Buffer.concat(chunks).toString()));
let configuration = {};
try {
  configuration = JSON.parse(await readFile(path.join(input.dataDirectory, "configuration.json"), "utf8"));
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
}
const repo = await Repository.open(path.join(input.dataDirectory, "company.sqlite"));
try {
  const result = await createBackup({
    databasePath: path.join(input.dataDirectory, "company.sqlite"),
    blobDirectory: path.join(input.dataDirectory, "blobs"),
    outputDirectory: input.outputDirectory,
    ageExecutable: input.ageExecutable,
    recipient: input.recipient,
    appVersion: input.appVersion,
    configuration,
    quiesce: async () => async () => {},
    snapshotDatabase: (destination) => repo.backup(destination),
  });
  process.stdout.write(
    JSON.stringify({
      ...result,
      executionIdentity: { uid: process.getuid?.(), gid: process.getgid?.(), groups: process.getgroups?.() },
    }),
  );
} finally {
  await repo.close();
}
