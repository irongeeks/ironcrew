import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "../../tests/e2e",
  testMatch: "ui.spec.ts",
  use: { baseURL: "http://127.0.0.1:8801", headless: true },
  workers: 1,
});
