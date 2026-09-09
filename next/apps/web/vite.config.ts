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
    manifest: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: "vendor-react",
              test: /\/node_modules\/(?:react|react-dom|scheduler)\//,
              priority: 10,
            },
            // Three exposes its shared scene/math core separately from WebGL.
            // Preserve those boundaries and keep both behind the lazy hall entry.
            {
              name: "vendor-three-core",
              test: /\/node_modules\/three\/build\/three\.core\.js$/,
              priority: 9,
              entriesAware: true,
            },
            {
              name: "vendor-three-renderer",
              test: /\/node_modules\/three\/build\/three\.module\.js$/,
              priority: 8,
              entriesAware: true,
            },
            {
              name: "vendor-three-addons",
              test: /\/node_modules\/three\//,
              priority: 7,
              entriesAware: true,
            },
          ],
        },
      },
    },
  },
});
