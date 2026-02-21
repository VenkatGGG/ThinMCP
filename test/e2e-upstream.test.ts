import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { UpstreamManager } from "../src/upstream-manager.js";

const shouldRun = process.env.THINMCP_RUN_E2E === "1";

test(
  "e2e: list tools from real upstream MCP servers",
  { skip: !shouldRun },
  async (t) => {
    const config = loadConfig(process.env.THINMCP_CONFIG);
    const enabledServers = config.servers.filter((server) => server.enabled !== false);

    assert.ok(
      enabledServers.length > 0,
      "No enabled servers found in config. Enable at least one server for e2e.",
    );

    const upstream = new UpstreamManager(enabledServers);

    try {
      for (const server of enabledServers) {
        await t.test(`listTools(${server.id})`, async () => {
          const tools = await upstream.listTools(server.id);
          assert.ok(Array.isArray(tools), "listTools must return an array");
          assert.ok(tools.length > 0, "server should expose at least one tool");
        });

        if (server.probe) {
          await t.test(`probeTool(${server.id}.${server.probe.toolName})`, async () => {
            const result = await upstream.callTool({
              serverId: server.id,
              name: server.probe.toolName,
              ...(server.probe.arguments
                ? { arguments: server.probe.arguments }
                : {}),
            });

            assert.ok(result, "probe tool must return a result payload");
          });
        }
      }
    } finally {
      await upstream.closeAll();
    }
  },
);
