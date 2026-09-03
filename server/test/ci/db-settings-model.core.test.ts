import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createReadSettingString, firstQueryValue } from "../../modules/bootstrap/helpers.ts";

describe("core DB/model helpers", () => {
  it("createReadSettingString reads persisted string settings safely", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)");
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("app.theme", "retro-dark");
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("feature.enabled", "true");

      const readSettingString = createReadSettingString(db as any);
      expect(readSettingString("app.theme")).toBe("retro-dark");
      expect(readSettingString("feature.enabled")).toBe("true");
      expect(readSettingString("missing.key")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("firstQueryValue normalizes sqlite row shapes", () => {
    expect(firstQueryValue("hello")).toBe("hello");
    expect(firstQueryValue(["hello", "world"])).toBe("hello");
    expect(firstQueryValue([1, "world"])).toBe("world");
    expect(firstQueryValue({})).toBeUndefined();
    expect(firstQueryValue(null)).toBeUndefined();
  });
});
