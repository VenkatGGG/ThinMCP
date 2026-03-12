# ThinMCP

A gateway that exposes many upstream MCP servers to an LLM through just two tools: `search()` and `execute()`. Instead of loading every tool schema into the model context, ThinMCP stores tool catalogs locally and lets the model discover and invoke tools on demand.

## Inspiration

This project is inspired by Cloudflare's [Code Mode: give agents an entire API in 1,000 tokens](https://blog.cloudflare.com/code-mode-mcp/). Cloudflare showed that for a large API (2,500+ endpoints), exposing individual tool definitions is unsustainable — their traditional MCP approach would have consumed 1.17 million tokens. Code Mode collapses the entire API surface into two functions (`search` and `execute`) running inside sandboxed V8 workers, cutting token usage by 99.9%.

ThinMCP generalizes this idea: instead of one API, it sits in front of **any number** of MCP servers and presents the same two-tool interface to the model.

## Why ThinMCP

When you connect many MCP servers directly to a model, every tool schema is sent as context. As tool count grows, context cost grows linearly and can crowd out task-relevant tokens.

ThinMCP keeps upstream tool metadata out of model context:

- **`search()`** — discover tools from a locally indexed catalog
- **`execute()`** — invoke any discovered tool with argument validation

Add 1 server or 100 — the model always sees 2 tools and context stays flat.

## Architecture

```
Model / Client
  └─ ThinMCP Gateway (search, execute)
       ├─ Catalog (SQLite) ← search queries
       └─ Proxy + validation ← execute calls
            └─ Upstream MCP servers (HTTP / stdio)

Sync scheduler
  └─ tools/list from upstreams → snapshots → SQLite catalog
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

- Fixed two-tool model interface (`search` + `execute`)
- HTTP and stdio upstream transports
- Local SQLite catalog with JSON snapshots
- Execute-time argument validation against cached schemas
- Sandboxed code execution for both tools
- HTTP transport mode with bearer or JWT/JWKS auth
- Redis-backed rate limiting for HTTP mode
- Stdio auto-restart with backoff and health snapshots
- Health (`/healthz`) and metrics (`/metrics`) endpoints

## Token Benchmarks

Measured with `tiktoken` `o200k_base` on minified `tools/list` JSON. ThinMCP gateway overhead is a constant **188 tokens**.

| Upstream server | Tools | Direct tokens | Reduction |
| --- | ---: | ---: | ---: |
| Filesystem MCP | 14 | 2,612 | 92.8% |
| Memory MCP | 9 | 2,117 | 91.1% |
| Everything MCP | 13 | 1,413 | 86.7% |
| Exa | 3 | 686 | 72.6% |
| Puppeteer MCP | 8 | 504 | 62.7% |
| Figma MCP | 5 | 427 | 56.0% |

**Stacked (all 5 + Cloudflare Docs):** 49 tools, 7,065 direct tokens → 188 tokens (**97.3% reduction, 37.6x smaller**).

## Requirements

- Node.js 20+
- npm
- Redis (optional, for HTTP rate limiting)

## Quick Start

```bash
# Install and build
npm install
npm run build

# Copy and edit config
cp config/mcp-sources.example.yaml config/mcp-sources.yaml
# Edit config/mcp-sources.yaml with your upstream servers

# Sync upstream tool catalogs
npm run sync

# Start in stdio mode (for desktop MCP clients)
npm start

# Or start in HTTP mode
npm start -- --transport http --port 8787
```

Validate your setup:

```bash
npm run doctor
```

## Configuration

Create `config/mcp-sources.yaml` from the example template. Each server entry requires:

```yaml
servers:
  - id: exa                    # unique identifier
    name: Exa MCP              # display name
    transport: http            # http or stdio
    url: https://mcp.exa.ai/mcp
    auth:
      type: none               # none | bearer_env
    allowTools: ["*"]          # glob patterns for tool filtering
```

For stdio servers, replace `url`/`auth` with `command`, `args`, `cwd`, `env`, and `stderr`.

Global settings:

```yaml
sync:
  intervalSeconds: 300         # re-sync interval
  onStart: true                # sync on startup

runtime:
  codeTimeoutMs: 15000
  maxCodeLength: 20000
  maxResultChars: 60000

catalog:
  dbPath: ./data/thinmcp.db
  snapshotDir: ./snapshots
```

## HTTP Mode

### Bearer auth

```bash
THINMCP_HTTP_TOKEN=your-secret npm start -- \
  --transport http \
  --http-auth-mode bearer \
  --http-auth-token-env THINMCP_HTTP_TOKEN
```

### JWT auth

```bash
npm start -- \
  --transport http \
  --http-auth-mode jwt \
  --http-jwt-jwks-url https://issuer.example.com/.well-known/jwks.json \
  --http-jwt-issuer https://issuer.example.com \
  --http-jwt-audience thinmcp-clients
```

Rate limiting (requires Redis):

```bash
npm start -- --transport http --redis-url redis://127.0.0.1:6379 --http-rate-limit 120 --http-rate-window-seconds 60
```

## Client Integration

See [docs/CLIENT_INTEGRATIONS.md](docs/CLIENT_INTEGRATIONS.md) for setup with Claude Desktop, Cursor, and other MCP clients.

Typical agent workflow:
1. `search()` to find relevant tools
2. `execute()` to call them
3. Return compact summaries

## Testing

```bash
npm test                          # unit tests
THINMCP_RUN_E2E=1 npm run test:e2e  # end-to-end (requires live upstreams)
```

## Security Notes

- Sandboxing provides practical runtime isolation, not adversarial multi-tenant hardening.
- Use `bearer_env` for upstream secrets — never hardcode tokens in config.
- Enable auth and rate limiting when exposing HTTP mode to shared environments.
- Restrict `allowTools` to least-privilege patterns per upstream.

## License

ISC
