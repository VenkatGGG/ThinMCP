import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CatalogStore } from "../src/catalog-store.js";
import type { NormalizedToolRecord, SourceServerConfig } from "../src/types.js";

test("CatalogStore.searchTools handles empty and filtered queries", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "thinmcp-catalog-"));
  const dbPath = path.join(tempDir, "catalog.db");
  const store = new CatalogStore(dbPath);

  try {
    const server: SourceServerConfig = {
      id: "exa",
      name: "Exa MCP",
      transport: "http",
      url: "https://mcp.exa.ai/mcp",
      auth: { type: "none" },
      allowTools: ["*"],
    };
    store.upsertServers([server]);

    const tools: NormalizedToolRecord[] = [
      {
        serverId: "exa",
        serverName: "Exa MCP",
        serverUrl: "https://mcp.exa.ai/mcp",
        toolName: "web_search_exa",
        title: "Web Search",
        description: "Web search with Exa",
        inputSchema: { type: "object" },
        outputSchema: null,
        annotations: null,
        searchableText: "web_search_exa web search with exa",
        snapshotHash: "snap1",
      },
    ];

    store.replaceServerTools("exa", "snap1", "/tmp/snap1.json", tools);

    const allTools = store.searchTools({});
    assert.equal(allTools.length, 1);
    assert.equal(allTools[0]?.toolName, "web_search_exa");

    const filtered = store.searchTools({ query: "web_search", limit: 10 });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0]?.serverId, "exa");

    const byServer = store.searchTools({ serverId: "exa", limit: 10 });
    assert.equal(byServer.length, 1);
    assert.equal(byServer[0]?.toolName, "web_search_exa");
  } finally {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
