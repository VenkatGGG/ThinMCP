import test from "node:test";
import assert from "node:assert/strict";
import { UpstreamManager } from "../src/upstream-manager.js";

test("UpstreamManager exposes disabled status in health snapshot", () => {
  const manager = new UpstreamManager([
    {
      id: "disabled-http",
      transport: "http",
      url: "https://example.com/mcp",
      enabled: false,
      auth: { type: "none" },
      allowTools: ["*"],
    },
  ]);

  const snapshot = manager.getHealthSnapshot();
  assert.equal(snapshot.length, 1);
  assert.equal(snapshot[0].status, "disabled");
  assert.equal(snapshot[0].enabled, false);
});

test("UpstreamManager retries stdio servers with backoff and updates health", async () => {
  const manager = new UpstreamManager(
    [
      {
        id: "broken-stdio",
        transport: "stdio",
        command: "definitely-not-a-real-command-thinmcp",
        enabled: true,
        allowTools: ["*"],
      },
    ],
    {
      stdio: {
        maxRetries: 1,
        baseBackoffMs: 10,
        maxBackoffMs: 20,
      },
    },
  );

  await assert.rejects(() => manager.listTools("broken-stdio"));

  const snapshot = manager.getHealthSnapshot();
  assert.equal(snapshot.length, 1);
  assert.equal(snapshot[0].serverId, "broken-stdio");
  assert.equal(snapshot[0].transport, "stdio");
  assert.equal(snapshot[0].failedCalls >= 1, true);
  assert.equal(snapshot[0].consecutiveFailures >= 1, true);
  assert.equal(snapshot[0].restarts >= 1, true);
  assert.ok(snapshot[0].lastError);
});
