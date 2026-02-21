import test from "node:test";
import assert from "node:assert/strict";
import { ToolProxy } from "../src/proxy.js";
import type { CatalogStore, ToolRecord } from "../src/catalog-store.js";
import type { UpstreamManager } from "../src/upstream-manager.js";

function buildStore(tool: ToolRecord): CatalogStore {
  const stub = {
    listServers() {
      return [
        {
          id: "server-a",
          name: "Server A",
          url: "https://example.com/mcp",
          enabled: true,
          allowTools: ["*"],
          lastSyncedAt: null,
        },
      ];
    },
    getTool(serverId: string, toolName: string) {
      if (serverId === tool.serverId && toolName === tool.toolName) {
        return tool;
      }

      return null;
    },
  };

  return stub as unknown as CatalogStore;
}

function buildUpstream(calls: Array<{ name: string; arguments?: Record<string, unknown> }>): UpstreamManager {
  const stub = {
    async callTool(input: { serverId: string; name: string; arguments?: Record<string, unknown> }) {
      calls.push({ name: input.name, arguments: input.arguments });
      return { ok: true };
    },
  };

  return stub as unknown as UpstreamManager;
}

function buildToolRecord(): ToolRecord {
  return {
    serverId: "server-a",
    serverName: "Server A",
    serverUrl: "https://example.com/mcp",
    toolName: "records.update",
    title: "Update record",
    description: "Update a record",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
      },
      required: ["id"],
    },
    outputSchema: null,
    annotations: null,
    snapshotHash: "snap1",
  };
}

test("ToolProxy blocks invalid args before upstream call", async () => {
  const calls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
  const proxy = new ToolProxy(buildStore(buildToolRecord()), buildUpstream(calls));

  await assert.rejects(
    () =>
      proxy.call({
        serverId: "server-a",
        name: "records.update",
        arguments: {},
      }),
    /validation failed/i,
  );

  assert.equal(calls.length, 0);
});

test("ToolProxy forwards valid args to upstream", async () => {
  const calls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
  const proxy = new ToolProxy(buildStore(buildToolRecord()), buildUpstream(calls));

  const result = await proxy.call({
    serverId: "server-a",
    name: "records.update",
    arguments: { id: "123" },
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "records.update");
});
