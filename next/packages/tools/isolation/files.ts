import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { IsolationError } from "./types.ts";
export const hash = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b, "en"))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export function safeRelative(value: string) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 2000 &&
    !path.isAbsolute(value) &&
    !value.includes("\\") &&
    [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127) &&
    !value.includes(":") &&
    value
      .split("/")
      .every(
        (part) =>
          !!part &&
          part !== "." &&
          part !== ".." &&
          !/^(\.env(?:\..*)?|\.git|\.ssh|\.ironcrew|con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(part) &&
          !/[. ]$/.test(part),
      )
  );
}
export async function treeHash(root: string) {
  const records: { path: string; type: string; value: string; mode: number }[] = [];
  async function visit(relative: string) {
    for (const name of (await readdir(path.join(root, relative))).sort()) {
      const item = relative ? relative + "/" + name : name,
        absolute = path.join(root, item),
        stat = await lstat(absolute);
      if (stat.isSymbolicLink()) {
        const value = await readlink(absolute);
        const resolved = path.resolve(root, value.startsWith("/") ? "." + value : path.join(path.dirname(item), value));
        if (resolved !== root && !resolved.startsWith(root + path.sep))
          throw new IsolationError("toolchain_link_escape");
        records.push({ path: item, type: "link", value, mode: 0 });
      } else if (stat.isDirectory()) {
        records.push({ path: item, type: "dir", value: "", mode: stat.mode & 0o777 });
        await visit(item);
      } else if (stat.isFile() && stat.nlink === 1)
        records.push({ path: item, type: "file", value: hash(await readFile(absolute)), mode: stat.mode & 0o777 });
      else throw new IsolationError("unsafe_toolchain");
    }
  }
  await visit("");
  return hash(canonical(records));
}
export async function snapshot(
  rootInput: string,
  destination: string,
  limits: { maxInputBytes: number; maxFiles: number },
) {
  const root = path.resolve(rootInput),
    initial = await lstat(root);
  if (initial.isSymbolicLink() || !initial.isDirectory() || (await realpath(root)) !== root)
    throw new IsolationError("unsafe_workspace");
  const rootFd = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const actualRoot = await rootFd.stat();
  if (actualRoot.ino !== initial.ino || actualRoot.dev !== initial.dev) {
    await rootFd.close();
    throw new IsolationError("input_changed");
  }
  const hashes: Record<string, string> = {};
  let bytes = 0,
    count = 0;
  async function visit(directory: import("node:fs/promises").FileHandle, relative: string): Promise<void> {
    // Every directory is pinned by an fd. Replacing a parent with a symlink cannot
    // redirect a later file open through the mutable host pathname.
    const anchor = "/proc/self/fd/" + directory.fd;
    for (const name of await readdir(anchor)) {
      const item = relative ? relative + "/" + name : name;
      if (++count > limits.maxFiles) throw new IsolationError("input_limit");
      if (!safeRelative(item)) throw new IsolationError("unsafe_input_path");
      const anchored = anchor + "/" + name,
        stat = await lstat(anchored);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || (stat.isFile() && stat.nlink !== 1))
        throw new IsolationError("unsafe_input_path");
      if (stat.isDirectory()) {
        const child = await open(anchored, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try {
          const actual = await child.stat();
          if (actual.ino !== stat.ino || actual.dev !== stat.dev) throw new IsolationError("input_changed");
          await mkdir(path.join(destination, item), { recursive: true, mode: 0o700 });
          await visit(child, item);
        } finally {
          await child.close();
        }
        continue;
      }
      if ((bytes += stat.size) > limits.maxInputBytes) throw new IsolationError("input_limit");
      const fd = await open(anchored, constants.O_RDONLY | constants.O_NOFOLLOW);
      let content: Buffer;
      try {
        const actual = await fd.stat();
        if (
          !actual.isFile() ||
          actual.nlink !== 1 ||
          actual.ino !== stat.ino ||
          actual.dev !== stat.dev ||
          actual.size !== stat.size
        )
          throw new IsolationError("input_changed");
        content = Buffer.alloc(stat.size);
        let offset = 0;
        while (offset < content.length) {
          const result = await fd.read(content, offset, content.length - offset, offset);
          if (result.bytesRead === 0) throw new IsolationError("input_changed");
          offset += result.bytesRead;
        }
        if ((await fd.stat()).size !== stat.size) throw new IsolationError("input_changed");
      } finally {
        await fd.close();
      }
      const handle = await open(path.join(destination, item), "wx", 0o600);
      try {
        await handle.writeFile(content);
      } finally {
        await handle.close();
      }
      hashes[item] = hash(content);
    }
  }
  try {
    await visit(rootFd, "");
    return hashes;
  } finally {
    await rootFd.close();
  }
}
