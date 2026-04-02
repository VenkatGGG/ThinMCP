# ThinMCP

ThinMCP is an MCP gateway that exposes many upstream MCP servers through a stable two-tool interface:

- `search()`
- `execute()`

Instead of loading every upstream tool definition into model context, ThinMCP keeps a local catalog, lets the model discover tools on demand, and forwards only the calls it needs to make.

## Why ThinMCP

Connecting multiple MCP servers directly to a model increases context size as tool count grows. ThinMCP keeps the model-facing surface area fixed while still allowing access to a large tool ecosystem.

The result is a simpler integration point for clients and a more predictable runtime shape for production deployments.

## Architecture

```mermaid
flowchart LR
    A["LLM / MCP Client"] -->|search() / execute()| B["ThinMCP Gateway"]
    B --> C["Local Catalog"]
    B --> D["Execution Layer"]
    D --> E["Schema Validation"]
    E --> F["Upstream MCP Servers"]
    G["Sync Process"] -->|tools/list| F
    G --> C
    G --> H["Snapshots"]
```

## Key Capabilities

- Fixed two-tool interface for the model
- Support for HTTP and stdio upstream servers
- Local SQLite-backed catalog for discovery
- Input validation before upstream execution
- Sandboxed execution for gateway tool calls
- HTTP transport with health and metrics endpoints
- Periodic sync of upstream tool metadata

## Quick Start

```bash
npm install
npm run build
cp config/mcp-sources.example.yaml config/mcp-sources.yaml
```

Edit `config/mcp-sources.yaml`, then sync and start:

```bash
npm run sync
npm start
```

HTTP mode:

```bash
npm start -- --transport http --port 8787
```

Validate the setup:

```bash
npm run doctor
```

## Configuration

ThinMCP reads `config/mcp-sources.yaml`. Each upstream server can use either `http` or `stdio` transport.

Minimal example:

```yaml
servers:
  - id: exa
    name: Exa MCP
    transport: http
    url: https://mcp.exa.ai/mcp
    auth:
      type: bearer_env
      env: EXA_API_KEY
    allowTools: ["*"]

  - id: local-fs
    name: Local Filesystem MCP
    transport: stdio
    command: npx
    args:
      - -y
      - "@modelcontextprotocol/server-filesystem"
      - /tmp
    cwd: .
    allowTools:
      - "filesystem.*"

sync:
  intervalSeconds: 300
  onStart: true

runtime:
  codeTimeoutMs: 15000
  maxCodeLength: 20000
  maxResultChars: 60000

catalog:
  dbPath: ../data/thinmcp.db
  snapshotDir: ../snapshots
```

Use `allowTools` to keep each upstream server scoped to the tools you actually want exposed through the gateway.

## Running ThinMCP

Development:

```bash
npm run dev
```

Production build:

```bash
npm run build
npm start
```

HTTP mode:

```bash
npm start -- --transport http --host 127.0.0.1 --port 8787
```

Available HTTP endpoints:

- `/mcp`
- `/healthz`
- `/metrics`

## Operations

Common commands:

```bash
npm run build
npm run sync
npm run doctor
npm test
THINMCP_RUN_E2E=1 npm run test:e2e
```

Operational guidance:

- Keep upstream credentials in environment variables
- Restrict `allowTools` to the smallest useful surface area
- Enable HTTP auth and rate limiting when exposing the gateway beyond local development
- Run `npm run sync` as part of deployment or startup validation if catalog freshness matters

## Client Integration

Client examples are documented in [docs/CLIENT_INTEGRATIONS.md](docs/CLIENT_INTEGRATIONS.md).

## License

ISC
