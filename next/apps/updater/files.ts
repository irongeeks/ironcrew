/** Queue and archive filesystem access under the data owner's identity; never chown. */
import path from "node:path";
import { mkdir, lstat, open, rename, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
const chunks = [];
let bytes = 0;
for await (const chunk of process.stdin) {
  bytes += chunk.length;
  if (bytes > 2_000_000) throw Error("Input too large");
  chunks.push(chunk);
}
const input = JSON.parse(Buffer.concat(chunks).toString());
async function main() {
  if (input.operation === "archive") {
    if (!path.isAbsolute(input.file)) throw Error("Archive path required");
    const handle = await open(input.file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1) throw Error("Not regular archive");
      const digest = createHash("sha256");
      for await (const chunk of handle.createReadStream({ autoClose: false })) digest.update(chunk);
      return { sha256: digest.digest("hex"), uid: info.uid, bytes: info.size };
    } finally {
      await handle.close();
    }
  }
  const directory = path.join(input.dataDirectory, "update-queue");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw Error("Unsafe queue directory");
  if (input.operation === "ensure") return null;
  if (input.operation === "list") return readdir(directory);
  if (!/^(updater-heartbeat|[a-f0-9-]{36}\.(request|progress|result))\.json$/.test(input.name))
    throw Error("Invalid queue name");
  const file = path.join(directory, input.name);
  if (input.operation === "read") {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > 2_000_000 || (info.mode & 0o022) !== 0)
        throw Error("Unsafe queue file");
      return JSON.parse(await handle.readFile("utf8"));
    } finally {
      await handle.close();
    }
  }
  if (input.operation === "write") {
    const temporary = file + "." + randomUUID() + ".tmp",
      h = await open(temporary, "wx", 0o600);
    try {
      await h.writeFile(JSON.stringify(input.value) + "\n");
      await h.sync();
    } finally {
      await h.close();
    }
    await rename(temporary, file);
    return null;
  }
  throw Error("Invalid operation");
}
try {
  process.stdout.write(JSON.stringify({ result: await main() }));
} catch (error) {
  process.stdout.write(
    JSON.stringify({ error: { code: error instanceof Error && "code" in error ? error.code : "owner_file_failed" } }),
  );
}
