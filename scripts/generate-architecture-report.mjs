#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const repoRoot = process.cwd();
const outputDir = path.join(repoRoot, "docs", "architecture");

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"];

// Both worktree directory names are skipped: a checkout older than the rename
// to IronCrew still has its worktrees under the pre-rename name.
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "logs", ".ironcrew-worktrees", ".octooffice-worktrees"]);

function toPosix(p) {
  return p.split(path.sep).join("/");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function shouldSkipFile(relPath) {
  const base = path.basename(relPath);
  if (base === ".DS_Store") return true;
  if (/\.sqlite(?:-wal|-shm)?$/i.test(base)) return true;
  return false;
}

function sortEntries(entries) {
  return entries.slice().sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });
}

function walkFiles(absDir, relDir = ".", output = []) {
  const entries = sortEntries(fs.readdirSync(absDir, { withFileTypes: true }));
  for (const entry of entries) {
    const absPath = path.join(absDir, entry.name);
    const relPath = toPosix(path.join(relDir, entry.name));

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkFiles(absPath, relPath, output);
      continue;
    }

    if (shouldSkipFile(relPath)) continue;
    output.push(relPath);
  }
  return output;
}

function isCodeFile(relPath) {
  return CODE_EXTENSIONS.has(path.extname(relPath));
}

function listCodeFiles() {
  return walkFiles(repoRoot)
    .filter((relPath) => (relPath.startsWith("src/") || relPath.startsWith("server/")) && isCodeFile(relPath))
    .sort();
}

function parseImportSpecifiers(sourceText) {
  const specs = new Set();
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[^"'`]*?\s+from\s*)?["']([^"']+)["']/g,
    /\bexport\s+[^"'`]*?\s+from\s+["']([^"']+)["']/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(sourceText)) !== null) {
      specs.add(match[1]);
    }
  }

  return [...specs];
}

function resolveRelativeImport(fromRelFile, specifier) {
  const fromAbs = path.join(repoRoot, fromRelFile);
  const fromDir = path.dirname(fromAbs);
  const baseAbs = path.resolve(fromDir, specifier);
  const tryPaths = [baseAbs];

  for (const ext of RESOLVE_EXTENSIONS) {
    tryPaths.push(baseAbs + ext);
  }

  for (const ext of RESOLVE_EXTENSIONS) {
    tryPaths.push(path.join(baseAbs, `index${ext}`));
  }

  for (const candidate of tryPaths) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      const rel = path.relative(repoRoot, candidate);
      return toPosix(rel);
    }
  }

  return null;
}

function normalizeExternalPackage(specifier) {
  if (!specifier) return specifier;
  if (specifier.startsWith("@")) {
    const [scope, pkg] = specifier.split("/");
    return pkg ? `${scope}/${pkg}` : specifier;
  }
  return specifier.split("/")[0];
}

function buildImportGraph(codeFiles) {
  const nodes = new Map();

  for (const relFile of codeFiles) {
    const absFile = path.join(repoRoot, relFile);
    const text = fs.readFileSync(absFile, "utf8");
    const specifiers = parseImportSpecifiers(text);

    const internalDeps = new Set();
    const externalDeps = new Set();

    for (const specifier of specifiers) {
      if (specifier.startsWith(".")) {
        const resolved = resolveRelativeImport(relFile, specifier);
        if (resolved) internalDeps.add(resolved);
      } else {
        externalDeps.add(normalizeExternalPackage(specifier));
      }
    }

    nodes.set(relFile, {
      internalDeps: [...internalDeps].sort(),
      externalDeps: [...externalDeps].sort(),
    });
  }

  return nodes;
}

function makeMermaidFlowchart(nodes, edges, direction = "LR") {
  const nodeList = [...new Set(nodes)].sort();
  const idMap = new Map(nodeList.map((node, i) => [node, `N${i + 1}`]));

  const lines = [`flowchart ${direction}`];
  for (const node of nodeList) {
    const id = idMap.get(node);
    const label = node.replaceAll('"', "'");
    lines.push(`  ${id}["${label}"]`);
  }

  for (const [from, to] of edges) {
    const fromId = idMap.get(from);
    const toId = idMap.get(to);
    if (!fromId || !toId) continue;
    lines.push(`  ${fromId} --> ${toId}`);
  }

  return lines.join("\n");
}

function buildFrontendGraph(importGraph) {
  const nodes = [];
  const edges = [];

  for (const [file, meta] of importGraph.entries()) {
    if (!file.startsWith("src/")) continue;
    nodes.push(file);
    for (const dep of meta.internalDeps) {
      if (dep.startsWith("src/")) {
        edges.push([file, dep]);
      }
    }
  }

  return makeMermaidFlowchart(nodes, edges, "LR");
}

function buildBackendDependencyGraph(importGraph) {
  const serverNode = "server/index.ts";
  const meta = importGraph.get(serverNode);
  const nodes = [serverNode];
  const edges = [];

  if (meta) {
    for (const ext of meta.externalDeps) {
      const label = `pkg:${ext}`;
      nodes.push(label);
      edges.push([serverNode, label]);
    }
  }

  return makeMermaidFlowchart(nodes, edges, "TB");
}

function extractApiRoutes() {
  const serverFile = path.join(repoRoot, "server", "index.ts");
  const text = fs.readFileSync(serverFile, "utf8");
  const routePattern = /\bapp\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/g;
  const routes = new Map();

  let match;
  while ((match = routePattern.exec(text)) !== null) {
    const method = match[1].toUpperCase();
    const route = match[2];
    routes.set(`${method} ${route}`, { method, route });
  }

  return [...routes.values()].sort((a, b) => {
    if (a.route === b.route) return a.method.localeCompare(b.method);
    return a.route.localeCompare(b.route);
  });
}

function extractApiCallsFromFrontend() {
  const apiFile = path.join(repoRoot, "src", "api.ts");
  const text = fs.readFileSync(apiFile, "utf8");
  const callPattern = /["'`](\/api\/[^"'`]+)["'`]/g;
  const calls = new Set();

  function normalizeEndpoint(raw) {
    let value = raw.trim();
    if (!value.startsWith("/api/")) return null;

    // Normalize template-literal path segments and drop query expressions.
    value = value.replace(/\$\{[^}]+\}/g, ":param");
    value = value.replace(/\$\{.*$/, "");
    value = value.split("?")[0];
    if (value.endsWith(":param") && !value.endsWith("/:param")) {
      value = value.slice(0, -":param".length);
    }
    value = value.replace(/\/+/g, "/");
    value = value.replace(/\/$/, "");

    if (!value.startsWith("/api/")) return null;
    return value;
  }

  let match;
  while ((match = callPattern.exec(text)) !== null) {
    const normalized = normalizeEndpoint(match[1]);
    if (normalized) calls.add(normalized);
  }

  return [...calls].sort();
}

function extractBroadcastEvents() {
  const serverFile = path.join(repoRoot, "server", "index.ts");
  const text = fs.readFileSync(serverFile, "utf8");
  const eventPattern = /\bbroadcast\(\s*["']([^"']+)["']/g;
  const events = new Set();

  let match;
  while ((match = eventPattern.exec(text)) !== null) {
    events.add(match[1]);
  }

  return [...events].sort();
}

function extractFrontendWsEvents() {
  const sourceFiles = walkFiles(path.join(repoRoot, "src"), "src").filter((relPath) => isCodeFile(relPath));
  const events = new Set();
  const onCall = /\bon\(\s*["']([^"']+)["']/g;

  for (const relPath of sourceFiles) {
    const text = fs.readFileSync(path.join(repoRoot, relPath), "utf8");
    let match;
    while ((match = onCall.exec(text)) !== null) {
      events.add(match[1]);
    }
  }

  return [...events].sort();
}

function extractDbTables() {
  const serverFile = path.join(repoRoot, "server", "index.ts");
  const text = fs.readFileSync(serverFile, "utf8");
  const tablePattern = /CREATE TABLE IF NOT EXISTS\s+([a-zA-Z0-9_]+)/g;
  const tables = new Set();

  let match;
  while ((match = tablePattern.exec(text)) !== null) {
    tables.add(match[1]);
  }

  return [...tables].sort();
}

function roleRank(role) {
  switch (role) {
    case "team_leader":
      return 1;
    case "senior":
      return 2;
    case "junior":
      return 3;
    case "intern":
      return 4;
    default:
      return 9;
  }
}

function readOrgData() {
  const dbPath = path.join(repoRoot, "octooffice.sqlite");
  if (!fs.existsSync(dbPath)) return [];

  let db;
  try {
    db = new DatabaseSync(dbPath, { readonly: true });
    const rows = db
      .prepare(
        `
      SELECT
        d.id AS department_id,
        d.name AS department_name,
        d.sort_order AS department_order,
        a.name AS agent_name,
        a.role AS role,
        a.cli_provider AS cli_provider
      FROM departments d
      LEFT JOIN agents a ON a.department_id = d.id
      ORDER BY d.sort_order ASC, a.name ASC
    `,
      )
      .all();

    const grouped = new Map();
    for (const row of rows) {
      const depId = row.department_id;
      if (!grouped.has(depId)) {
        grouped.set(depId, {
          id: depId,
          name: row.department_name,
          order: row.department_order,
          agents: [],
        });
      }
      if (row.agent_name) {
        grouped.get(depId).agents.push({
          name: row.agent_name,
          role: row.role,
          cliProvider: row.cli_provider,
        });
      }
    }

    for (const dep of grouped.values()) {
      dep.agents.sort((a, b) => {
        const rank = roleRank(a.role) - roleRank(b.role);
        if (rank !== 0) return rank;
        return a.name.localeCompare(b.name);
      });
    }

    return [...grouped.values()].sort((a, b) => a.order - b.order);
  } catch {
    return [];
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // noop
      }
    }
  }
}

function buildOrgMermaid(orgData) {
  const lines = ["flowchart TD", '  CEO["CEO"]'];
  let depIndex = 1;
  let agentIndex = 1;

  for (const dep of orgData) {
    const depId = `D${depIndex++}`;
    lines.push(`  ${depId}[\"${dep.name}\"]`);
    lines.push(`  CEO --> ${depId}`);

    for (const agent of dep.agents) {
      const aId = `A${agentIndex++}`;
      const label = `${agent.name} (${agent.role}/${agent.cliProvider})`.replaceAll('"', "'");
      lines.push(`  ${aId}[\"${label}\"]`);
      lines.push(`  ${depId} --> ${aId}`);
    }
  }

  return lines.join("\n");
}

function buildTree() {
  function collapse(relPath, entries) {
    if (relPath === "public/sprites") {
      return `public/sprites/ (${entries.length} sprite files)`;
    }
    if (entries.length >= 40 && entries.every((e) => e.isFile())) {
      return `${relPath}/ (${entries.length} files)`;
    }
    return null;
  }

  const lines = [path.basename(repoRoot)];

  function walk(absDir, relDir, prefix = "") {
    let entries = fs.readdirSync(absDir, { withFileTypes: true });
    entries = sortEntries(entries).filter((entry) => {
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) return false;
      const relPath = toPosix(path.join(relDir, entry.name));
      return !shouldSkipFile(relPath);
    });

    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      const isLast = i === entries.length - 1;
      const branch = isLast ? "└── " : "├── ";
      const nextPrefix = prefix + (isLast ? "    " : "│   ");
      const absPath = path.join(absDir, entry.name);
      const relPath = toPosix(path.join(relDir, entry.name));

      if (entry.isDirectory()) {
        const childEntries = fs.readdirSync(absPath, { withFileTypes: true });
        const collapsed = collapse(relPath, childEntries);
        if (collapsed) {
          lines.push(`${prefix}${branch}${collapsed}`);
          continue;
        }

        lines.push(`${prefix}${branch}${entry.name}/`);
        walk(absPath, relPath, nextPrefix);
      } else {
        lines.push(`${prefix}${branch}${entry.name}`);
      }
    }
  }

  walk(repoRoot, ".");
  return lines.join("\n");
}

function toMarkdownTable(headers, rows) {
  const headerLine = `| ${headers.join(" | ")} |`;
  const divider = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${row.join(" | ")} |`).join("\n");
  return [headerLine, divider, body].join("\n");
}

function main() {
  ensureDir(outputDir);

  const generatedAt = new Date().toISOString();
  const codeFiles = listCodeFiles();
  const importGraph = buildImportGraph(codeFiles);

  const frontendGraph = buildFrontendGraph(importGraph);
  const backendGraph = buildBackendDependencyGraph(importGraph);
  const routes = extractApiRoutes();
  const frontendCalls = extractApiCallsFromFrontend();
  const backendEvents = extractBroadcastEvents();
  const frontendEvents = extractFrontendWsEvents();
  const tables = extractDbTables();
  const orgData = readOrgData();
  const orgMermaid = buildOrgMermaid(orgData);
  const treeText = buildTree();

  const eventSet = new Set([...backendEvents, ...frontendEvents]);
  const eventRows = [...eventSet]
    .sort()
    .map((event) => [event, backendEvents.includes(event) ? "yes" : "", frontendEvents.includes(event) ? "yes" : ""]);

  const routeRows = routes.map((r) => [r.method, `\`${r.route}\``]);
  const callRows = frontendCalls.map((c) => [`\`${c}\``]);
  const tableRows = tables.map((name) => [`\`${name}\``]);

  const orgRows = orgData.flatMap((dep) => {
    if (dep.agents.length === 0) {
      return [[dep.name, "(none)", "", ""]];
    }
    return dep.agents.map((agent) => [dep.name, agent.name, agent.role, agent.cliProvider]);
  });

  const payload = {
    generatedAt,
    files: {
      codeFiles,
    },
    routes,
    frontendCalls,
    websocket: {
      serverBroadcasts: backendEvents,
      frontendListeners: frontendEvents,
    },
    database: {
      tables,
    },
    organization: orgData,
  };

  fs.writeFileSync(path.join(outputDir, "source-tree.txt"), `${treeText}\n`, "utf8");
  fs.writeFileSync(path.join(outputDir, "frontend-imports.mmd"), `${frontendGraph}\n`, "utf8");
  fs.writeFileSync(path.join(outputDir, "backend-dependencies.mmd"), `${backendGraph}\n`, "utf8");
  fs.writeFileSync(path.join(outputDir, "org-chart.mmd"), `${orgMermaid}\n`, "utf8");
  fs.writeFileSync(path.join(outputDir, "architecture.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  const readme = `# Architecture Map

Generated at: ${generatedAt}

## How to Regenerate

\`\`\`bash
npm run arch:map
\`\`\`

## System Overview

\`\`\`mermaid
flowchart LR
  subgraph Frontend
    F1["src/main.tsx"] --> F2["src/App.tsx"]
    F2 --> F3["src/components/*"]
    F2 --> F4["src/api.ts"]
    F2 --> F5["src/hooks/*"]
  end

  subgraph Backend
    B1["server/index.ts"] --> B2["Express REST API"]
    B1 --> B3["WebSocket Server"]
    B1 --> B4["SQLite (octooffice.sqlite)"]
    B1 --> B5["Git Worktree + CLI Process"]
  end

  F4 <-->|"HTTP /api/*"| B2
  F5 <-->|"ws://"| B3
\`\`\`

## Project Tree

\`\`\`text
${treeText}
\`\`\`

## Frontend Import Graph

\`\`\`mermaid
${frontendGraph}
\`\`\`

## Backend Dependency Graph

\`\`\`mermaid
${backendGraph}
\`\`\`

## API Routes (Server)

${toMarkdownTable(["Method", "Route"], routeRows)}

## API Calls (Frontend)

${toMarkdownTable(["Endpoint Pattern"], callRows)}

## WebSocket Event Matrix

${toMarkdownTable(["Event", "Server Broadcast", "Frontend Listen"], eventRows)}

## DB Tables

${toMarkdownTable(["Table"], tableRows)}

## Sub-Agent Organization (from SQLite)

\`\`\`mermaid
${orgMermaid}
\`\`\`

${toMarkdownTable(["Department", "Agent", "Role", "CLI Provider"], orgRows)}
`;

  fs.writeFileSync(path.join(outputDir, "README.md"), readme, "utf8");
  console.log(`[architecture] generated: ${path.join(outputDir, "README.md")}`);
}

main();
