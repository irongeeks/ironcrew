# Marketplaces

IronCrew can install **skills** and **MCP servers** from outside this machine.
A marketplace is anything it can ask _"what can I install from you?"_ — four
kinds ship today.

## The four kinds

| kind            | what you point it at                          |
| --------------- | --------------------------------------------- |
| `catalog`       | a plain JSON catalog at a URL                 |
| `mcp-registry`  | `https://registry.modelcontextprotocol.io`    |
| `claude-plugin` | a repo with `.claude-plugin/marketplace.json` |
| `git`           | one repository, installed directly            |

All four answer in the same shape (`MarketplaceEntry`), differing only in
whose JSON they parse. Everything downstream of `fetchEntries` sees one type.

### `catalog` — the format anyone can host

```json
{
  "entries": [
    {
      "id": "github",
      "type": "mcp",
      "name": "github",
      "title": "GitHub",
      "description": "…",
      "version": "1.2.0",
      "mcp": {
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-github"],
        "env": { "GITHUB_TOKEN": "" }
      }
    },

    { "id": "pr-review", "type": "skill", "name": "pr-review", "skill": { "repo": "acme/skills" } }
  ]
}
```

`items`, `servers`, `skills` and a bare array are accepted as aliases. An
entry that could never be installed (a stdio server with no command, a skill
with no content) is **skipped**, not fatal: one malformed row in someone
else's catalog should not hide the other hundred.

### `mcp-registry` — the official registry

Reads `GET <base>/v0/servers`, follows the cursor, and turns each package into
a runnable command: `npm` → `npx -y <pkg>@<version>`, `pypi` → `uvx`,
`nuget` → `dnx`.

Two honest limitations rather than convenient lies:

- A server offered **only** over streamable-http is not listed. IronCrew's MCP
  connector speaks stdio and SSE (`mcp-connector.ts`); labelling it "sse"
  would produce an entry that installs and then never connects.
- Declared `environmentVariables` become **empty placeholders**. The registry
  says which variables a server needs, never their values, and IronCrew does
  not invent them — you supply them at install.

### `claude-plugin` — a Claude-Code marketplace

Point it at the manifest or at the repository holding it; GitHub and GitLab
repo URLs are resolved to the raw `.claude-plugin/marketplace.json` (`main`,
then `master`).

Each plugin becomes a **skill** entry; each server under its `mcpServers`
becomes its **own mcp entry**, so you approve each server on its own rather
than accepting a bundle sight unseen.

### `git` — one repository as the offer

Paste `https://github.com/acme/pr-review`, `acme/pr-review`, or a `.git`
clone URL. IronCrew looks for `.claude-plugin/plugin.json` (for a better name
and description) and `.mcp.json` (for servers), and always offers the
repository itself as a skill. Both manifests are optional.

## Adding a source

Command Center → **Marktplätze** → _Neue Quelle_, or:

```http
POST /api/crew/marketplaces
{ "name": "acme", "kind": "catalog", "url": "https://example.com/catalog.json" }
```

A source's `kind` is fixed for its lifetime — it decides how the URL is
parsed, so changing it would silently reinterpret the same URL.

## Browsing

```http
GET /api/crew/marketplaces/:id/entries
```

Catalogs are read **live and never cached**. They are third-party JSON that
changes without notice, and a stale cache of installable commands is worse
than a fetch. The outcome of each read is recorded on the source row
(`entry_count`, `last_error`, `last_synced_at`), so a source that has been
broken for a week says so in the UI without anyone clicking it again.

A broken catalog answers **502 `marketplace_unreachable`** — the request was
fine, someone else's server was not.

## Installing

```http
POST /api/crew/marketplaces/:id/install
{ "entryId": "github", "env": { "GITHUB_TOKEN": "ghp_…" } }
```

Install takes an entry **id**, never an entry body: the server re-fetches the
entry from its source, so what lands is what that source offers now, not a
payload a caller composed.

### Where things actually land

IronCrew adds provenance to infrastructure that already exists rather than a
second copy of it:

- **MCP servers** → `McpManager` and the `settings` row `"mcp_servers"`,
  exactly where a hand-added server lives. A marketplace-installed server is
  byte-identical to one you typed in yourself.
- **Skills** → `<cwd>/custom-skills/<name>/{skills.md, meta.json}`, the layout
  the custom-skills route already uses. `meta.json` also carries the source,
  so a directory on disk can say where it came from.

`crew_marketplace_installs` records what was installed, from where, by whom
and when. Removing a source sets `marketplace_id` to `NULL` rather than
erasing the record: the artefact is still on this machine, so its origin must
stay answerable.

## The trust boundary

The installer is where third-party JSON meets this machine. Four checks stand
between a catalog entry and the disk:

1. **A launcher allowlist.** An MCP `command` from a catalog is arbitrary code
   IronCrew would spawn on connect. A marketplace install may only name a
   known launcher: `npx`, `bunx`, `pnpm`, `uvx`, `uv`, `node`, `deno`,
   `python`, `python3`, `dnx`, `dotnet`. Anything else is refused **with the
   command named**, so you can add it by hand if you mean to. Adding a server
   yourself through the MCP settings route is unaffected — that is your
   decision about your own machine; a stranger's catalog is not.
2. **`McpServerConfigSchema`**, the same validation the hand-add route runs:
   shell metacharacters in the command are rejected, cloud metadata endpoints
   are blocked.
3. **Installing a skill executes nothing.** The Markdown is fetched and
   written. The source repository is not cloned, not installed, not run.
   A skill is text.
4. **Path containment**, plus the 512 KB cap the custom-skills route already
   enforces.

A refused install answers **422 `install_refused`** — a policy answer about
this machine, not a malformed request.

Marketplace servers are registered with **`autoConnect: false`**: you decide
when a stranger's server first runs, not the install click. Connect it from
the MCP settings when you are ready.

Every fetch goes through `safeFetch` (DNS-pinned, SSRF-guarded), so a mistyped
URL cannot turn IronCrew into a metadata proxy.

## Uninstalling

```http
DELETE /api/crew/marketplace-installs/:entryType/:name
```

Removes the artefact and its provenance row. The artefact goes first: a record
saying "installed" next to nothing on disk is a lie, while an orphaned server
with no record is merely untidy and visible in the MCP settings.
