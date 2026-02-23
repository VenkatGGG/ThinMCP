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
- [x] Worker-isolated sandbox runtime with memory limits and hard termination
- [x] Automated test suite (`npm test`) for sandbox/proxy/validation/output shaping
- [x] Client integration guide (`docs/CLIENT_INTEGRATIONS.md`)
- [x] Upstream MCP support over `stdio` in addition to Streamable HTTP
- [x] HTTP gateway auth + rate limits (`--http-auth-token*`, `--http-rate-*`)
- [x] Real-upstream e2e test entrypoint (`npm run test:e2e`)
- [x] Redis-backed shared HTTP rate limiter (`--redis-url`)
- [x] JWT/JWKS inbound auth mode (`--http-auth-mode jwt`)
- [x] Stdio upstream auto-restart/backoff + health snapshots (`/healthz`, `/metrics`)

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

## Token Reduction (Measured)

ThinMCP keeps a constant tool surface (`search`, `execute`) in model context, even as you add more upstream MCP servers.

That means tool-schema context cost stays flat on the LLM side while your connected capability set grows.

### Why this avoids context pollution

- Without ThinMCP: model receives every upstream tool schema (cost grows with each server/tool).
- With ThinMCP: model always receives the same two tool schemas.
- Result: you can keep adding MCP servers without growing tool-schema prompt tokens.

### Benchmarks (`tiktoken` `o200k_base`, minified `tools/list` JSON)

| Scenario | Upstream tools | Direct MCP tokens | ThinMCP tokens | Reduction |
| --- | ---: | ---: | ---: | ---: |
| Exa (`mcp.exa.ai`) | 3 | 686 | 188 | 72.59% |
| Cloudflare Docs MCP | 2 | 278 | 188 | 32.37% |
| Filesystem MCP (`@modelcontextprotocol/server-filesystem`) | 14 | 2612 | 188 | 92.80% |
| Memory MCP (`@modelcontextprotocol/server-memory`) | 9 | 2117 | 188 | 91.12% |
| Everything MCP (`@modelcontextprotocol/server-everything`) | 13 | 1413 | 188 | 86.69% |
| Figma MCP (`figma-mcp`) | 5 | 427 | 188 | 55.97% |
| Puppeteer MCP (`puppeteer-mcp-server`) | 8 | 504 | 188 | 62.70% |

### Multi-MCP aggregate benchmark

- Stacked MCPs: Filesystem + Memory + Everything + Figma + Puppeteer
- Total upstream tools: `49`
- Direct tool-schema footprint: `7065` tokens
- ThinMCP tool-schema footprint: `188` tokens
- Net reduction: `97.34%` (`37.58x` smaller)

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
npm test
npm run test:e2e   # runs only if THINMCP_RUN_E2E=1
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

HTTP auth + rate limit options:

```bash
npm run dev -- \
  --transport http \
  --http-auth-mode bearer \
  --http-auth-token-env THINMCP_HTTP_TOKEN \
  --redis-url redis://127.0.0.1:6379 \
  --http-rate-limit 120 \
  --http-rate-window-seconds 60
```

Or set `THINMCP_HTTP_TOKEN` directly in environment.

JWT auth mode:

```bash
npm run dev -- \
  --transport http \
  --http-auth-mode jwt \
  --http-jwt-jwks-url https://issuer.example.com/.well-known/jwks.json \
  --http-jwt-issuer https://issuer.example.com \
  --http-jwt-audience thinmcp-clients
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

- ThinMCP supports upstream MCP servers over both Streamable HTTP and stdio transports.
- Sandboxing runs in a dedicated worker with memory limits and wall-clock termination, still intended for local trusted usage rather than hostile multi-tenant workloads.
- Client setup examples are in `/Users/sri/Desktop/silly_experiments/ThinMCP/docs/CLIENT_INTEGRATIONS.md`.
- Real-upstream e2e tests are opt-in: set `THINMCP_RUN_E2E=1` and configure enabled servers (plus tokens) in config.
- HTTP health and metrics are available at `/healthz` and `/metrics` in HTTP mode and include upstream stdio health snapshots.
- Parallel Web Systems MCP endpoints (`search-mcp.parallel.ai`, `task-mcp.parallel.ai`) require API auth (`x-api-key` or `Authorization` bearer token).
