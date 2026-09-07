import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
export class OperationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "OperationError";
  }
}
export function safeRelative(value: string): boolean {
  return (
    value.length > 0 &&
    value.length < 2000 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.includes(":") &&
    ![...value].some((char) => char.charCodeAt(0) < 32) &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}
export async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
export async function confinedFile(root: string, relative: string): Promise<string> {
  if (!safeRelative(relative)) throw new OperationError("unsafe_path", "Dateipfad liegt außerhalb der Ablage.");
  const base = await realpath(root);
  let current = base;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    if ((await lstat(current)).isSymbolicLink())
      throw new OperationError("unsafe_path", "Symbolische Verknüpfungen sind nicht zulässig.");
  }
  const file = await realpath(current);
  if (!file.startsWith(base + path.sep) || !(await lstat(file)).isFile())
    throw new OperationError("unsafe_path", "Ablagedatei ist nicht regulär.");
  return file;
}
