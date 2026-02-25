# ThinMCP

ThinMCP is a gateway that lets you expose many upstream MCP servers to an LLM while keeping the model-facing tool surface fixed to two tools:

- `search()`
- `execute()`

Instead of loading every upstream tool schema into the model context, ThinMCP stores tool catalogs locally and lets the model discover and invoke tools through code.

## Inspiration

This project is inspired by Cloudflare's Code Mode approach for reducing MCP tool-context overhead:

- [Code Mode: give agents an entire API in 1,000 tokens](https://blog.cloudflare.com/code-mode-mcp/)

## Why ThinMCP

### The problem

When you connect many MCP servers directly to a model, every tool schema is sent to the model. As tool count grows, context cost grows linearly and can crowd out task-relevant tokens.

### The approach

ThinMCP keeps upstream tool metadata out of model context and presents only:

- `search()` for discovery over a local indexed catalog
- `execute()` for controlled calls to upstream tools

### Core benefit

ThinMCP gives you an effectively unbounded MCP integration layer from a context-footprint perspective:

- Add 1 MCP server or 100 MCP servers.
- The model still sees the same 2 gateway tools.
- Tool-schema context stays flat (runtime/network costs still scale with usage).

## Architecture

```text
Model Client
  -> ThinMCP Gateway MCP Server (search, execute)
      -> Search runtime (catalog API over SQLite)
      -> Execute runtime (tool.call -> proxy + validation)
          -> Upstream MCP servers (HTTP and/or stdio)

Sync scheduler
  -> tools/list from upstreams
  -> snapshots/*.json
  -> normalized catalog in SQLite
```

## Architecture Deep Dive

### Component file map

| Component | File | Responsibility |
| --- | --- | --- |
| Entry point | `src/index.ts` | CLI parsing, server bootstrap, transport selection |
| Gateway server | `src/gateway-server.ts` | Registers `search` and `execute` MCP tools on the gateway |
| Catalog store | `src/catalog-store.ts` | SQLite-backed tool catalog (insert, FTS search, lookup) |
| Sync service | `src/sync-service.ts` | Pulls `tools/list` from upstreams, writes snapshots, upserts catalog |
| Upstream manager | `src/upstream-manager.ts` | Manages MCP client connections (HTTP and stdio), health tracking, auto-restart with backoff |
| Tool proxy | `src/proxy.ts` | Routes `execute` calls to the correct upstream via `UpstreamManager` |
| Schema validator | `src/schema-validator.ts` | Validates tool arguments against cached JSON Schema before proxying |
| Sandbox | `src/sandbox.ts` | Runs user-submitted code in a `worker_threads` isolate with timeout |
| Sandbox worker | `src/sandbox-worker.ts` | Worker-thread entry point that evaluates sandboxed code |
| Runtime APIs | `src/runtime-apis.ts` | Builds the `catalog` and `tool` API objects injected into sandbox code |
| Execute output | `src/execute-output.ts` | Normalizes and size-limits values returned from `execute` |
| HTTP transport | `src/http-transport.ts` | Express-like HTTP listener exposing `/mcp`, `/healthz`, `/metrics` |
| HTTP auth | `src/http-auth.ts` | Inbound auth: bearer token comparison or JWT/JWKS verification |
| Rate limiter | `src/rate-limit.ts` | Redis-backed fixed-window rate limiter for HTTP mode |
| Config loader | `src/config.ts` | Parses and validates `mcp-sources.yaml` into typed config |
| Types | `src/types.ts` | Shared TypeScript interfaces and config types |
| Logger | `src/logger.ts` | Structured logging helpers (`logInfo`, `logWarn`, `logError`) |
| Doctor | `src/doctor.ts` | Connectivity and config validation CLI (`npm run doctor`) |
| Server utils | `src/server-utils.ts` | Helper to resolve server endpoint URLs |

### Runtime flow

1. `src/index.ts` loads config via `src/config.ts` and opens the catalog database (`src/catalog-store.ts`).
2. `src/upstream-manager.ts` connects to each upstream MCP server (HTTP or stdio).
3. If `sync.onStart` is set, `src/sync-service.ts` runs an initial sync: calls `tools/list` on each upstream, writes JSON snapshots, and upserts rows into the SQLite catalog.
4. `src/gateway-server.ts` registers two tools on the MCP SDK server:
   - **search** -- sandboxed code receives `catalog` API (`src/runtime-apis.ts` -> `src/catalog-store.ts`).
   - **execute** -- sandboxed code receives `tool` API (`src/runtime-apis.ts` -> `src/proxy.ts` -> `src/upstream-manager.ts`).
5. Both tools run user code inside `src/sandbox.ts`, which spawns a `worker_threads` isolate (`src/sandbox-worker.ts`) with a configurable timeout.

### Sync lifecycle

- `src/sync-service.ts` iterates enabled servers, calls `tools/list` through `src/upstream-manager.ts`, writes per-server JSON snapshots to the configured `snapshotDir`, and upserts tool metadata into SQLite via `src/catalog-store.ts`.
- Sync can run on a timer (`sync.intervalSeconds`) or be triggered manually with `npm run sync`.

### Security and auth

- **Inbound (HTTP mode):** `src/http-auth.ts` (`HttpAuthenticator`) supports bearer-token comparison and JWT verification against a remote JWKS endpoint. Auth is enforced in `src/http-transport.ts` before any MCP message is processed.
- **Upstream credentials:** Configured per-server via `auth.type: bearer_env` in `mcp-sources.yaml`; tokens are read from environment variables at runtime and never stored in config files.
- **Sandbox isolation:** `src/sandbox.ts` executes model-generated code in a `worker_threads` worker with no access to the host `require`/`import`, limited to injected APIs only, and enforces a wall-clock timeout.

### Rate limiting

`src/rate-limit.ts` implements a Redis-backed fixed-window rate limiter. When enabled via `--http-rate-limit` and `--redis-url`, `src/http-transport.ts` calls the limiter before processing each inbound request. The limiter is keyed per-client and returns standard `429` responses when the window quota is exceeded.

### Reliability

`src/upstream-manager.ts` tracks per-server health state including call counts, consecutive failures, and restart counts. Stdio transports are automatically restarted with exponential backoff (configurable `maxRetries`, `baseBackoffMs`, `maxBackoffMs`). Health snapshots are exposed through the `/metrics` endpoint in HTTP mode.

### Operations

- `/healthz` -- returns `200` when the gateway is accepting connections (`src/http-transport.ts`).
- `/metrics` -- returns JSON with catalog size, upstream health snapshots, and uptime (`src/http-transport.ts`, provider in `src/index.ts`).
- `npm run doctor` -- validates config, tests upstream connectivity, and reports catalog state (`src/doctor.ts`).

## Features

- Fixed model-facing interface: `search()` + `execute()`
- Sync and normalize upstream tools from many MCP servers
- HTTP and stdio upstream support
- Local catalog storage (SQLite) with snapshots
- Execute-time argument validation against cached schemas
- Worker-isolated code execution for `search()` and `execute()` runtime
- HTTP transport mode for ThinMCP itself
- Inbound auth for HTTP mode: bearer token or JWT/JWKS
- HTTP rate limiting with Redis-backed shared limiter
- Upstream stdio auto-restart/backoff with health snapshots
- Health and metrics endpoints in HTTP mode

## Benchmarks

Token counts measured using `tiktoken` `o200k_base` on minified `tools/list` JSON.

### Single-server comparisons

| Scenario | Upstream tools | Direct MCP tokens | ThinMCP tokens | Reduction |
| --- | ---: | ---: | ---: | ---: |
| Exa (`mcp.exa.ai`) | 3 | 686 | 188 | 72.59% |
| Cloudflare Docs MCP | 2 | 278 | 188 | 32.37% |
| Filesystem MCP (`@modelcontextprotocol/server-filesystem`) | 14 | 2612 | 188 | 92.80% |
| Memory MCP (`@modelcontextprotocol/server-memory`) | 9 | 2117 | 188 | 91.12% |
| Everything MCP (`@modelcontextprotocol/server-everything`) | 13 | 1413 | 188 | 86.69% |
| Figma MCP (`figma-mcp`) | 5 | 427 | 188 | 55.97% |
| Puppeteer MCP (`puppeteer-mcp-server`) | 8 | 504 | 188 | 62.70% |

### Multi-server aggregate

Stacked servers: Filesystem + Memory + Everything + Figma + Puppeteer

- Total upstream tools: `49`
- Direct tool-schema footprint: `7065` tokens
- ThinMCP tool-schema footprint: `188` tokens
- Reduction: `97.34%` (`37.58x` smaller)

## Requirements

- Node.js 20+
- npm
- Optional: Redis (for shared HTTP rate limiting)

## Quick Start

### 1. Install and build

```bash
cd ThinMCP
npm install
npm run typecheck
npm run build
```

### 2. Configure upstream MCP sources

Edit:

- `ThinMCP/config/mcp-sources.yaml`

Reference template:

- `ThinMCP/config/mcp-sources.example.yaml`

Minimal example (public Exa MCP):

```yaml
servers:
  - id: exa
    name: Exa MCP
    transport: http
    url: https://mcp.exa.ai/mcp
    auth:
      type: none
    allowTools: ["*"]

sync:
  intervalSeconds: 300
  onStart: true

runtime:
  codeTimeoutMs: 15000
  maxCodeLength: 20000
  maxResultChars: 60000

catalog:
  dbPath: ./data/thinmcp.db
  snapshotDir: ./snapshots
```

### 3. Sync upstream tools

```bash
npm run sync
```

Sync one server:

```bash
npm run sync -- --server exa
```

### 4. Start ThinMCP

Stdio mode (for desktop MCP clients):

```bash
npm run dev
```

HTTP mode:

```bash
npm run dev:http
```

Custom host/port:

```bash
npm run dev -- --transport http --host 0.0.0.0 --port 8787
```

### 5. Validate setup

```bash
npm run doctor
```

## Configuration Reference

### Server entries

Each `servers[]` entry supports:

- `id` (string, required)
- `name` (string, optional)
- `enabled` (boolean, optional, default `true`)
- `allowTools` (string[], optional, default `[*]`)
- `probe` (optional tool for connectivity checks)

HTTP upstream:

- `transport: http`
- `url`
- `auth`:
  - `type: none`
  - `type: bearer_env`, `env: YOUR_ENV_VAR`

Stdio upstream:

- `transport: stdio`
- `command`
- `args` (optional)
- `cwd` (optional)
- `env` (optional)
- `stderr` (`inherit` or `pipe`)

### Runtime block

- `runtime.codeTimeoutMs`
- `runtime.maxCodeLength`
- `runtime.maxResultChars`

### Catalog block

- `catalog.dbPath`
- `catalog.snapshotDir`

## Running ThinMCP Over HTTP

### Bearer auth mode

```bash
THINMCP_HTTP_TOKEN=supersecret \
npm run dev -- \
  --transport http \
  --http-auth-mode bearer \
  --http-auth-token-env THINMCP_HTTP_TOKEN \
  --redis-url redis://127.0.0.1:6379 \
  --http-rate-limit 120 \
  --http-rate-window-seconds 60
```

### JWT auth mode

```bash
npm run dev -- \
  --transport http \
  --http-auth-mode jwt \
  --http-jwt-jwks-url https://issuer.example.com/.well-known/jwks.json \
  --http-jwt-issuer https://issuer.example.com \
  --http-jwt-audience thinmcp-clients \
  --redis-url redis://127.0.0.1:6379 \
  --http-rate-limit 120
```

### Operational endpoints

- `GET /healthz`
- `GET /metrics`

## Using From MCP Clients

Client integration examples:

- `ThinMCP/docs/CLIENT_INTEGRATIONS.md`

Recommended model interaction pattern:

1. Call `search()` to discover candidate tools.
2. Call `execute()` for targeted tool operations.
3. Return compact summaries instead of large raw payloads.

Example `search()` code:

```js
async () => {
  const tools = await catalog.findTools({ query: "dns", limit: 10 });
  return tools.map((t) => ({ serverId: t.serverId, toolName: t.toolName }));
}
```

Example `execute()` code:

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

## Testing

```bash
npm test
npm run test:e2e
```

Notes:

- `test:e2e` runs real upstream checks only when `THINMCP_RUN_E2E=1`.
- Some tests are intentionally skipped unless optional dependencies/services are configured.

## Security and Production Notes

- ThinMCP sandboxing is designed for practical local/runtime isolation, not adversarial multi-tenant hardening.
- Restrict upstream permissions to least privilege.
- Prefer `bearer_env` for upstream secrets; do not hardcode tokens in config files.
- For HTTP mode in shared environments, enable auth and rate limiting.
- Some third-party MCP endpoints require API keys or OAuth (for example Parallel MCP and Cloudflare API MCP).

## Troubleshooting

- `Config file not found`: set `THINMCP_CONFIG` or place config at `ThinMCP/config/mcp-sources.yaml`.
- `Missing env token for <server>`: export the environment variable referenced by `auth.env`.
- `Unauthorized` from upstream: verify API key/OAuth token and scopes.
- Stdio server startup failures: verify command, args, and working directory in server config.

## License

ISC
