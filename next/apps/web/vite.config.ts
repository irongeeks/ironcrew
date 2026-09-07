import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  server: { host: "127.0.0.1", port: 8801, proxy: { "/api": "http://127.0.0.1:8790" } },
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
  },
});
