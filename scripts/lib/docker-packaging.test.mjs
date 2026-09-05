import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (file) => readFileSync(path.join(root, file), "utf8");
const dockerfile = read("Dockerfile");
const production = dockerfile.split("FROM base AS production")[1];
const compose = yaml.load(read("compose.yaml"));

function* serverSources(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (["test", "__fixtures__"].includes(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* serverSources(file);
    else if (entry.name.endsWith(".ts") && !/\.(test|spec)\.ts$/.test(entry.name)) yield file;
  }
}

function volumeFor(service, file) {
  return service.volumes
    .map((volume) => {
      const [source, target] = volume.split(":");
      return { source, target };
    })
    .filter(({ target }) => file === target || file.startsWith(target + "/"))
    .sort((a, b) => b.target.length - a.target.length)[0];
}

describe("Docker control-plane packaging", () => {
  it("includes cross-tree TypeScript runtime imports and required company config", () => {
    const copiedTrees = [...production.matchAll(/COPY --from=builder \/app\/(\S+) /g)].map((match) => match[1]);
    for (const file of serverSources(path.join(root, "server"))) {
      for (const match of readFileSync(file, "utf8").matchAll(/(?:from|import)\s*["'](\.[^"']+)["']/g)) {
        const target = path.relative(root, path.resolve(path.dirname(file), match[1]));
        if (!target.startsWith("src/")) continue;
        expect(
          copiedTrees.some((tree) => target === tree || target.startsWith(tree + "/")),
          `Runtime import ${target} must be copied into production`,
        ).toBe(true);
      }
    }
    expect(copiedTrees).toContain("config");
    for (const file of ["vendor-policy.yaml", "agents.seed.yaml", "departments.yaml", "memory.yaml"]) {
      expect(read(`config/${file}`).length).toBeGreaterThan(0);
    }
  });

  it.each(["ironcrew", "ironcrew-dev"])(
    "persists runtime data and policy config for %s without renaming the existing database",
    (name) => {
      const service = compose.services[name];
      expect(service.environment.DB_PATH).toBe("/data/octooffice.sqlite");
      const data = volumeFor(service, service.environment.DB_PATH);
      expect(data.source).toBe("octooffice-data");
      for (const file of ["/app/data/private-assets/characters", "/app/data/crew-attachments", "/data/vault"]) {
        expect(volumeFor(service, file)?.source, file).toBe(data.source);
      }
      expect(service.environment.OBSIDIAN_VAULT_PATH).toBe("${OBSIDIAN_VAULT_PATH:-/data/vault}");
      expect(service.volumes).toContain("./config:/app/config:ro");
    },
  );

  it("excludes local uploads, vault content and private config from the image build context", () => {
    const rules = read(".dockerignore")
      .split(/\r?\n/)
      .map((line) => line.trim());
    for (const rule of ["data/", "vault/", "config/private/*"]) expect(rules).toContain(rule);
  });
});
