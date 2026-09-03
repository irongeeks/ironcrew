import type { DatabaseSync } from "node:sqlite";

type DbLike = Pick<DatabaseSync, "exec" | "prepare"> & {
  isTransaction?: boolean;
};

export function createRunInTransaction(db: DbLike): (fn: () => void) => void {
  return (fn: () => void): void => {
    if (db.isTransaction) {
      fn();
      return;
    }
    db.exec("BEGIN");
    try {
      fn();
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // ignore rollback failure
      }
      throw err;
    }
  };
}

export function nowMs(): number {
  return Date.now();
}

export async function sleepMs(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function firstQueryValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const first = value.find((item) => typeof item === "string");
    return typeof first === "string" ? first : undefined;
  }
  return undefined;
}

export function createReadSettingString(db: DbLike): (key: string) => string | undefined {
  return (key: string): string | undefined => {
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value?: unknown } | undefined;
      if (!row || typeof row.value !== "string") return undefined;
      const trimmed = row.value.trim();
      return trimmed || undefined;
    } catch {
      return undefined;
    }
  };
}
