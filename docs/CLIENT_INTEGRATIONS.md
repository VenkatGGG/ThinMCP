# ThinMCP Client Integrations

This guide shows how to connect common MCP clients to ThinMCP.

## 1) Start ThinMCP

Stdio mode:

```bash
cd /Users/sri/Desktop/silly_experiments/ThinMCP
npm run dev
```

HTTP mode:

```bash
cd /Users/sri/Desktop/silly_experiments/ThinMCP
npm run dev:http
```

## 2) Claude Desktop (stdio)

Add to your Claude Desktop MCP config:

```json
{
  "mcpServers": {
    "thinmcp": {
      "command": "node",
      "args": ["/Users/sri/Desktop/silly_experiments/ThinMCP/dist/index.js"]
    }
  }
}
```

For development without build:

```json
{
  "mcpServers": {
    "thinmcp": {
      "command": "npm",
      "args": ["run", "dev"],
      "cwd": "/Users/sri/Desktop/silly_experiments/ThinMCP"
    }
  }
}
```

## 3) HTTP-capable MCP Clients

For clients that support Streamable HTTP MCP servers:

```json
{
  "mcpServers": {
    "thinmcp": {
      "url": "http://127.0.0.1:8787/mcp"
    }
  }
}
```

Health endpoint:

```text
http://127.0.0.1:8787/healthz
```

## 4) Recommended Tool Prompting Pattern

Tell your model to:

1. Use `search()` first to discover tools.
2. Then call `execute()` with targeted `tool.call({ serverId, name, arguments })` steps.
3. Return compact summaries, not raw binary payloads.
