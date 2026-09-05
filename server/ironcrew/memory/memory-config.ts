import { readFileSync } from "node:fs";
import { load } from "js-yaml";
import { z } from "zod";
import { HonchoConfigSchema } from "./honcho-provider.ts";
export const MemoryConfigSchema = z.object({ version: z.literal(1), honcho: HonchoConfigSchema }).strict();
/** Missing optional config means disabled; malformed configuration must surface. */
export function loadMemoryConfig(file: string) {
  try {
    return MemoryConfigSchema.parse(load(readFileSync(file, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return MemoryConfigSchema.parse({ version: 1, honcho: { enabled: false } });
    throw error;
  }
}
