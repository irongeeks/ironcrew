/** Fixed-method database bridge, always launched as the data owner by the independent updater. */
import path from "node:path";
import { createInterface } from "node:readline";
import { Repository } from "../../packages/persistence/src/index.ts";
const directory = process.argv[2];
if (!directory || !path.isAbsolute(directory)) throw new Error("Absolute data directory required");
const repo = await Repository.open(path.join(directory, "company.sqlite"));
const methods = new Set(["snapshot", "getDocument", "listDocuments", "transact", "putDocument", "setupState", "close"]);
try {
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    if (Buffer.byteLength(line) > 2_000_000) throw new Error("Database request exceeds limit");
    const input = JSON.parse(line);
    if (!Number.isSafeInteger(input.id) || !methods.has(input.method) || !Array.isArray(input.args))
      throw new Error("Invalid database method");
    try {
      const result = await Reflect.apply(Reflect.get(repo, input.method), repo, input.args);
      process.stdout.write(JSON.stringify({ id: input.id, result: result ?? null }) + "\n");
    } catch (error) {
      const code =
        error instanceof Error && "code" in error && typeof error.code === "string"
          ? error.code
          : "owner_database_failed";
      process.stdout.write(JSON.stringify({ id: input.id, error: { code } }) + "\n");
    }
    if (input.method === "close") break;
  }
} finally {
  await repo.close();
  process.stdin.destroy();
}
