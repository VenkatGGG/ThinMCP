# ThinMCP

ThinMCP is a local MCP gateway that compresses many upstream MCP servers into two tools:

- `search()`
- `execute()`

You give your model only ThinMCP. ThinMCP keeps the full upstream tool surface out of model context and exposes a compact, code-driven interface.

## Current Status

### Progress Log

- [x] Project scaffold (TypeScript, MCP SDK, config layout)
- [x] Local catalog store (SQLite) and snapshot persistence
- [x] Upstream MCP sync pipeline (`tools/list` -> normalized catalog)
- [x] `search()` and `execute()` tool registration in gateway MCP server
- [x] On-demand refresh when `execute()` sees stale or missing tool metadata
- [x] Basic sandbox hardening (frozen runtime globals + timeout + code-length limit)
- [x] Targeted sync for one upstream with `--server <id>`
- [x] `doctor` command to validate config + auth env wiring
- [x] Optional HTTP transport for ThinMCP server (`--transport http`)
- [x] `execute()` argument validation against cached tool input schemas
- [x] Non-text/large tool outputs normalized before model return

## Architecture

```text
Model Client
  -> ThinMCP MCP Server (search, execute)
      -> Search runtime (catalog API over SQLite)
      -> Execute runtime (tool.call -> MCP proxy)
          -> Upstream MCP servers

Sync scheduler
  -> tools/list from upstreams
  -> snapshots/*.json
  -> normalized catalog in SQLite
```

## Configure Upstream MCP Sources

Edit `/Users/sri/Desktop/silly_experiments/ThinMCP/config/mcp-sources.yaml`.

Reference template: `/Users/sri/Desktop/silly_experiments/ThinMCP/config/mcp-sources.example.yaml`.

Auth tokens are read from environment variables when `auth.type = bearer_env`.

## Run

```bash
cd /Users/sri/Desktop/silly_experiments/ThinMCP
npm install
npm run typecheck
npm run build
```

Sync only:

```bash
npm run sync
```

Sync only for a single server:

```bash
npm run sync -- --server cloudflare
```

Start ThinMCP MCP server (stdio):

```bash
npm run dev
```

Start ThinMCP MCP server over HTTP (Streamable HTTP):

```bash
npm run dev:http
```

Custom host/port:

```bash
npm run dev -- --transport http --host 0.0.0.0 --port 8787
```

Validate local setup:

```bash
npm run doctor
```

## Example Usage in Model Tool Calls

### `search()`

```js
async () => {
  const tools = catalog.findTools({ query: "dns", limit: 10 });
  return tools.map((t) => ({ serverId: t.serverId, toolName: t.toolName }));
}
```

### `execute()`

```js
async () => {
  const result = await tool.call({
    serverId: "cloudflare",
    name: "zones.list",
    arguments: { account_id: "abc123" }
  });

  return result;
}
```

## Notes

- ThinMCP currently supports upstream MCP servers over Streamable HTTP.
- Stdio upstream servers are intentionally out of scope for this initial version.
- Sandboxing uses Node `vm` with limits. This is sufficient for local trusted usage, not hardened multi-tenant isolation.
