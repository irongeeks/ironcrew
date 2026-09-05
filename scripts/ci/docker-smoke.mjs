#!/usr/bin/env node
/** Isolated production-image verification. Own disposable container/volume only. */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
const image = process.argv[2];
if (!image) throw new Error("Usage: node scripts/ci/docker-smoke.mjs image-tag");
const suffix = randomUUID();
const container = `ironcrew-smoke-${suffix}`;
const volume = `ironcrew-smoke-${suffix}`;
const docker = (args) => {
  const result = spawnSync("docker", args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`docker ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
};
const exec = (code) => docker(["exec", container, "node", "--input-type=module", "-e", code]);
async function healthy() {
  for (let attempt = 0; attempt < 90; attempt++) {
    const state = JSON.parse(docker(["inspect", container]))[0].State;
    if (!state.Running) throw new Error("Container exited before becoming healthy.");
    if (state.Health?.Status === "healthy") return;
    await delay(1000);
  }
  throw new Error("Production container did not become healthy within 90 seconds.");
}
try {
  docker(["volume", "create", volume]);
  docker([
    "run",
    "-d",
    "--name",
    container,
    "--network",
    "none",
    "--mount",
    `type=volume,source=${volume},target=/data`,
    "--mount",
    `type=volume,source=${volume},target=/app/data`,
    "--env",
    "DB_PATH=/data/octooffice.sqlite",
    "--env",
    "LOGS_DIR=/data/logs",
    "--env",
    "OBSIDIAN_VAULT_PATH=/data/vault",
    "--env",
    "IRONCREW_SCHEDULER=off",
    "--env",
    "OAUTH_ENCRYPTION_SECRET=isolated-ci-fixture-encryption-key-000000000000",
    "--health-interval",
    "1s",
    "--health-start-period",
    "5s",
    image,
  ]);
  await healthy();
  exec(`import assert from 'node:assert/strict';import fs from 'node:fs';import {DatabaseSync} from 'node:sqlite';
    const health=await fetch('http://127.0.0.1:8790/health');assert.equal(health.status,200);
    const db=new DatabaseSync('/data/octooffice.sqlite');
    for(const table of ['crew_companies','crew_tasks','crew_memory_sync','crew_runs'])assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));
    db.exec("CREATE TABLE deployment_probe(value TEXT);INSERT INTO deployment_probe VALUES('persistent')");db.close();
    for(const [file,value] of [['/app/data/private-assets/characters/probe.txt','private-character'],['/data/vault/probe.md','vault-note'],['/app/data/crew-attachments/probe.txt','attachment']]){
      fs.mkdirSync(file.slice(0,file.lastIndexOf('/')),{recursive:true});fs.writeFileSync(file,value);
    }
  `);
  docker(["restart", container]);
  await healthy();
  exec(`import assert from 'node:assert/strict';import fs from 'node:fs';import {DatabaseSync} from 'node:sqlite';
    assert.equal(fs.readFileSync('/app/data/private-assets/characters/probe.txt','utf8'),'private-character');
    assert.equal(fs.readFileSync('/data/vault/probe.md','utf8'),'vault-note');
    const db=new DatabaseSync('/data/octooffice.sqlite',{readOnly:true});assert.equal(db.prepare('SELECT value FROM deployment_probe').get().value,'persistent');db.close();`);
  docker([
    "exec",
    container,
    "node",
    "scripts/ironcrew-backup.mjs",
    "--db",
    "/data/octooffice.sqlite",
    "--attachments",
    "/app/data/crew-attachments",
    "--extra",
    "/app/data/private-assets/characters",
    "--extra",
    "/data/vault",
    "--out",
    "/data/backups",
  ]);
  const archive = exec(
    `import fs from 'node:fs';process.stdout.write('/data/backups/'+fs.readdirSync('/data/backups').find((p)=>p.endsWith('.tar.gz')));`,
  );
  docker([
    "exec",
    container,
    "node",
    "scripts/ironcrew-backup.mjs",
    "--restore",
    archive,
    "--db",
    "/data/restored.sqlite",
    "--attachments",
    "/data/restored-attachments",
  ]);
  exec(`import assert from 'node:assert/strict';import fs from 'node:fs';import {DatabaseSync} from 'node:sqlite';
    const db=new DatabaseSync('/data/restored.sqlite',{readOnly:true});assert.equal(db.prepare('SELECT value FROM deployment_probe').get().value,'persistent');
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');db.close();
    assert.equal(fs.readFileSync('/data/restored-attachments/probe.txt','utf8'),'attachment');
    const extras=fs.readdirSync('/data').find((name)=>name.startsWith('restored-extras-'));assert.ok(extras);
    const walk=(dir)=>fs.readdirSync(dir,{withFileTypes:true}).flatMap((entry)=>entry.isDirectory()?walk(dir+'/'+entry.name):[fs.readFileSync(dir+'/'+entry.name,'utf8')]);
    const values=walk('/data/'+extras);assert.ok(values.includes('private-character'));assert.ok(values.includes('vault-note'));`);
  console.log(
    "Production image: health, migrations, persisted DB/assets/vault, restart and verified backup/restore passed without network access.",
  );
} catch (error) {
  const logs = spawnSync("docker", ["logs", "--tail", "100", container], { encoding: "utf8" });
  console.error(logs.stdout, logs.stderr);
  throw error;
} finally {
  spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });
  spawnSync("docker", ["volume", "rm", volume], { stdio: "ignore" });
}
