import { constants, createReadStream, openSync } from "node:fs";
import { open, lstat, realpath, readdir, mkdir, rename, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import path from "node:path";
import { MAX_BYTES, MAX_FILES, manifestSchema, type Manifest } from "./protocol.ts";
import { safeRelative } from "../isolation/files.ts";
export async function receiveFile(stream: Readable, target: string, expected: { size: number; sha256: string }) {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = target + "." + randomUUID() + ".partial";
  const handle = await open(temporary, "wx", 0o600);
  let bytes = 0;
  const hash = createHash("sha256");
  try {
    for await (const chunk of stream) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += data.length;
      if (bytes > expected.size || bytes > MAX_BYTES) throw new Error("upload_size_limit");
      hash.update(data);
      await handle.writeFile(data);
    }
    if (bytes !== expected.size || hash.digest("hex") !== expected.sha256) throw new Error("file_hash_mismatch");
    await handle.sync();
    await handle.close();
    await rename(temporary, target);
    if (process.platform === "win32") return; // Windows has no portable directory-fsync API; file fsync remains mandatory.
    const directory = await open(path.dirname(target), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(temporary, { force: true });
    throw error;
  }
}
export async function verifyFile(file: string, expected: { size: number; sha256: string }) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== expected.size)
    throw new Error("file_hash_mismatch");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  const hash = createHash("sha256");
  try {
    const actual = await handle.stat();
    if (actual.ino !== stat.ino || actual.dev !== stat.dev) throw new Error("file_changed");
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    if (hash.digest("hex") !== expected.sha256) throw new Error("file_hash_mismatch");
  } finally {
    await handle.close();
  }
}
/** Cross-platform snapshot of a trusted managed workspace; no untrusted code can write the source host. */
export async function captureFiles(rootInput: string, destination: string): Promise<Manifest> {
  if ((await lstat(path.resolve(rootInput))).isSymbolicLink()) throw new Error("unsafe_workspace");
  const root = await realpath(path.resolve(rootInput));
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const files: Manifest = [];
  let bytes = 0,
    count = 0;
  async function visit(relative: string) {
    for (const name of (await readdir(path.join(root, relative))).sort()) {
      const item = relative ? relative + "/" + name : name;
      if (!safeRelative(item) || item.length > 512 || ++count > MAX_FILES) throw new Error("unsafe_input_path");
      const source = path.join(root, item),
        stat = await lstat(source);
      if (stat.isSymbolicLink() || (await realpath(source)) !== source) throw new Error("unsafe_input_path");
      if (stat.isDirectory()) {
        await visit(item);
        continue;
      }
      if (!stat.isFile() || stat.nlink !== 1 || (bytes += stat.size) > MAX_BYTES) throw new Error("input_limit");
      const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
      const hash = createHash("sha256");
      const target = path.join(destination, String(files.length));
      try {
        const actual = await handle.stat();
        if (
          actual.dev !== stat.dev ||
          actual.ino !== stat.ino ||
          actual.size !== stat.size ||
          (await realpath(source)) !== source
        )
          throw new Error("input_changed");
        const out = await open(target, "wx", 0o600);
        let n = 0;
        try {
          for await (const chunk of handle.createReadStream({ autoClose: false })) {
            n += chunk.length;
            if (n > stat.size) throw new Error("input_changed");
            hash.update(chunk);
            await out.writeFile(chunk);
          }
          if (n !== stat.size) throw new Error("input_changed");
          await out.sync();
        } finally {
          await out.close();
        }
        if ((await realpath(source)) !== source || (await lstat(source)).ino !== stat.ino)
          throw new Error("input_changed");
      } finally {
        await handle.close();
      }
      files.push({ path: item, size: stat.size, sha256: hash.digest("hex") });
    }
  }
  await visit("");
  return manifestSchema.parse(files);
}
export function sendFile(file: string) {
  return createReadStream(file, { fd: openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW), autoClose: true });
}
