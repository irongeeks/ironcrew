#!/usr/bin/env node
/** Real local Docker/Compose update and backup. Only registry resolution is a fixture.
 * CI supplies an already-built production image; no production project is touched.
 */
import fs from "node:fs/promises";
import process from "node:process";
import console from "node:console";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { runDocker, parseDockerUpdateArgs, updateDockerRelease } from "../lib/docker-update.mjs";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--image" || !args[1] || /[\s\n]/.test(args[1]))
  throw new Error("Usage: node scripts/ci/docker-update-smoke.mjs --image <already-built-local-production-image>");
const image = args[1],
  repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "ironcrew-update-smoke-"));
const cwd = path.join(root, "company"),
  backupDir = path.join(root, "backups");
const project = `ironcrew-update-smoke-${randomBytes(6).toString("hex")}`;
const localRelease = `ironcrew-update-smoke:${randomBytes(6).toString("hex")}`;
const revision = "f".repeat(40),
  fakeDigest = `sha256:${"e".repeat(64)}`,
  published = `ghcr.io/irongeeks/ironcrew@${fakeDigest}`;
const compose = [
  "compose",
  "--env-file",
  ".env",
  "-f",
  "compose.yaml",
  "-f",
  "compose.release.yaml",
  "--profile",
  "prod",
];
const command = (arguments_, extra = {}) =>
  runDocker(arguments_, { cwd, env: { ...process.env, IRONCREW_RELEASE_IMAGE: image }, ...extra });
let created = false,
  built = false;
try {
  await fs.mkdir(cwd);
  await fs.mkdir(path.join(cwd, "workspaces"));
  // The supplied image must exist locally. This smoke never pulls an arbitrary base.
  await command(["image", "inspect", image]);
  const version = (
    await command([
      "run",
      "--rm",
      "--network",
      "none",
      "--entrypoint",
      "node",
      image,
      "-p",
      "require('./package.json').version",
    ])
  ).trim();
  assert.match(version, /^\d+\.\d+\.\d+$/);
  await fs.cp(path.join(repo, "config"), path.join(cwd, "config"), {
    recursive: true,
    filter: (source) => !path.relative(path.join(repo, "config"), source).split(path.sep).includes("private"),
  });
  await fs.writeFile(
    path.join(cwd, ".env"),
    `COMPOSE_PROJECT_NAME=${project}\nDOCKER_UPDATE_SMOKE_SECRET=fixture-only\nIRONCREW_SCHEDULER=off\nOAUTH_ENCRYPTION_SECRET=isolated-ci-fixture-encryption-key-000000000000\n`,
    { mode: 0o600 },
  );
  await fs.writeFile(
    path.join(cwd, "compose.yaml"),
    `services:
  ironcrew:
    profiles: [prod]
    env_file: .env
    environment:
      NODE_ENV: production
      DB_PATH: /data/octooffice.sqlite
      LOGS_DIR: /data/logs
      OBSIDIAN_VAULT_PATH: /data/vault
      HOST: 0.0.0.0
    volumes:
      - octooffice-data:/data
      - octooffice-data:/app/data
      - ./config:/app/config:ro
      - ./workspaces:/workspaces
volumes:
  octooffice-data:
`,
  );
  await fs.copyFile(path.join(repo, "compose.release.yaml"), path.join(cwd, "compose.release.yaml"));
  await fs.writeFile(
    path.join(root, "Dockerfile"),
    `ARG BASE_IMAGE\nFROM \${BASE_IMAGE}\nLABEL org.opencontainers.image.version="${version}" org.opencontainers.image.revision="${revision}"\n`,
  );
  await command(
    [
      "build",
      "--pull=false",
      "--build-arg",
      `BASE_IMAGE=${image}`,
      "--tag",
      localRelease,
      "--file",
      path.join(root, "Dockerfile"),
      root,
    ],
    { discardOutput: true },
  );
  built = true;
  created = true;
  await command(
    [...compose, "up", "-d", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "180", "ironcrew"],
    { discardOutput: true, timeout: 240_000 },
  );
  const oldContainer = (await command([...compose, "ps", "--quiet", "ironcrew"])).trim();
  await command([
    "exec",
    oldContainer,
    "node",
    "-e",
    "require('node:fs').writeFileSync('/data/update-sentinel.txt','volume survives')",
  ]);
  const company = JSON.parse(
    await command([
      "exec",
      oldContainer,
      "node",
      "--input-type=module",
      "-e",
      `import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync('/data/octooffice.sqlite');const company=db.prepare('SELECT id,name FROM crew_companies ORDER BY id LIMIT 1').get();if(!company)throw new Error('No seeded company');db.prepare('INSERT INTO crew_tasks(id,company_id,title,status) VALUES(?,?,?,?)').run('docker-update-smoke-task',company.id,'Persistent release upgrade fixture','planned');db.close();process.stdout.write(JSON.stringify(company));`,
    ]),
  );
  await fs.writeFile(path.join(cwd, "workspaces", "workspace-sentinel.txt"), "workspace survives");
  const envBefore = await fs.readFile(path.join(cwd, ".env"), "utf8");
  const manifestFile = path.join(root, "release-manifest.json");
  await fs.writeFile(
    manifestFile,
    JSON.stringify({
      schemaVersion: 1,
      version,
      tag: `v${version}`,
      commit: revision,
      container: { image: `ghcr.io/irongeeks/ironcrew:v${version}`, digest: fakeDigest },
    }),
  );
  const options = parseDockerUpdateArgs(["--to", `v${version}`, "--backup-dir", backupDir, "--manifest", manifestFile]);
  function registryFixture(failHealth = false) {
    let healthReads = 0;
    return async (arguments_, context) => {
      // No fake command sequence: stop, image save, tar, up, mounts and health all run on Docker.
      // A local image substitutes only for the remote GHCR transport unavailable before publishing.
      if (arguments_[0] === "pull" && arguments_[1] === published) return "";
      if (arguments_[0] === "image" && arguments_[1] === "inspect" && arguments_[2] === published) {
        const metadata = JSON.parse(await runDocker(["image", "inspect", localRelease], context));
        metadata[0].RepoDigests = [published];
        return JSON.stringify(metadata);
      }
      const result = await runDocker(arguments_, {
        ...context,
        env: { ...context.env, IRONCREW_RELEASE_IMAGE: localRelease },
      });
      if (failHealth && arguments_[0] === "exec" && ++healthReads === 2)
        return JSON.stringify({ ...JSON.parse(result), version: "0.0.0" });
      return result;
    };
  }
  const result = await updateDockerRelease(options, {
    cwd,
    env: { ...process.env, COMPOSE_PROJECT_NAME: project },
    run: registryFixture(),
  });
  assert.equal(result.verified, true);
  assert.equal(result.project, project);
  assert.equal(await fs.readFile(path.join(cwd, ".env"), "utf8"), envBefore);
  const current = (
    await command([...compose, "ps", "--quiet", "ironcrew"], {
      env: { ...process.env, IRONCREW_RELEASE_IMAGE: localRelease },
    })
  ).trim();
  assert.equal(
    await command([
      "exec",
      current,
      "node",
      "-p",
      "require('node:fs').readFileSync('/data/update-sentinel.txt','utf8')",
    ]),
    "volume survives\n",
  );
  const persisted = JSON.parse(
    await command([
      "exec",
      current,
      "node",
      "--input-type=module",
      "-e",
      `import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync('/data/octooffice.sqlite',{readOnly:true});process.stdout.write(JSON.stringify(db.prepare("SELECT company_id,title,status FROM crew_tasks WHERE id='docker-update-smoke-task'").get()));db.close();`,
    ]),
  );
  assert.deepEqual(persisted, {
    company_id: company.id,
    title: "Persistent release upgrade fixture",
    status: "planned",
  });
  const record = JSON.parse(await fs.readFile(result.recoveryRecord, "utf8"));
  const data = record.backups.find((entry) => entry.mountType === "volume");
  assert.ok(data);
  const contents = await command([
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--mount",
    `type=bind,src=${data.file},dst=/archive.tar,readonly`,
    "--entrypoint",
    "tar",
    image,
    "-tf",
    "/archive.tar",
  ]);
  assert.ok(contents.includes("update-sentinel.txt"));
  assert.ok(contents.includes("octooffice.sqlite"));
  assert.equal((await fs.stat(data.file)).mode & 0o777, 0o600);
  const snapshotDirectory = path.join(root, "snapshot-inspection");
  await fs.mkdir(snapshotDirectory, { mode: 0o700 });
  for (const name of ["octooffice.sqlite", "octooffice.sqlite-wal", "octooffice.sqlite-shm"]) {
    const entry = contents.split(/\r?\n/).find((item) => item === name || item === `./${name}`);
    if (!entry) continue;
    await command(
      [
        "run",
        "--rm",
        "--network",
        "none",
        "--read-only",
        "--mount",
        `type=bind,src=${data.file},dst=/archive.tar,readonly`,
        "--entrypoint",
        "tar",
        image,
        "-xOf",
        "/archive.tar",
        entry,
      ],
      { outputFile: path.join(snapshotDirectory, name) },
    );
  }
  const snapshotDb = new DatabaseSync(path.join(snapshotDirectory, "octooffice.sqlite"), { readOnly: true });
  try {
    assert.deepEqual(
      {
        ...snapshotDb
          .prepare("SELECT company_id,title,status FROM crew_tasks WHERE id='docker-update-smoke-task'")
          .get(),
      },
      persisted,
    );
  } finally {
    snapshotDb.close();
  }

  // Avoid keeping two full image archives on small CI disks; this is only the owned fixture backup.
  assert.ok(result.backupDirectory.startsWith(backupDir + path.sep));
  await fs.rm(result.backupDirectory, { recursive: true });
  await assert.rejects(
    updateDockerRelease(options, {
      cwd,
      env: { ...process.env, COMPOSE_PROJECT_NAME: project },
      run: registryFixture(true),
    }),
    /Service remains stopped/,
  );
  const running = (
    await command([...compose, "ps", "--quiet", "--status", "running", "ironcrew"], {
      env: { ...process.env, IRONCREW_RELEASE_IMAGE: localRelease },
    })
  ).trim();
  assert.equal(running, "");
  console.log(
    "Docker updater smoke passed: real stopped-volume backup, preserved data/config, healthy update and fail-stopped recovery; registry resolution used a local fixture.",
  );
} finally {
  // Only the unique ephemeral project created above is ever removed, never operator volumes.
  if (created)
    await command([...compose, "--project-name", project, "down", "--volumes", "--remove-orphans"], {
      discardOutput: true,
      signal: undefined,
    });
  if (built) await command(["image", "rm", localRelease], { discardOutput: true, signal: undefined });
  await fs.rm(root, { recursive: true, force: true });
}
