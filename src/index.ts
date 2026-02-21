import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CatalogStore } from "./catalog-store.js";
import { loadConfig } from "./config.js";
import { createGatewayServer } from "./gateway-server.js";
import { logError, logInfo } from "./logger.js";
import { ToolProxy } from "./proxy.js";
import { SyncService } from "./sync-service.js";
import { UpstreamManager } from "./upstream-manager.js";

async function main(): Promise<void> {
  const config = loadConfig();

  const store = new CatalogStore(config.catalog.dbPath);
  store.upsertServers(config.servers);

  const upstream = new UpstreamManager(config.servers);
  const syncService = new SyncService(store, upstream, config.catalog);

  if (config.sync.onStart) {
    await syncService.syncAllServers();
  }

  if (process.argv.includes("--sync-only")) {
    await upstream.closeAll();
    store.close();
    logInfo("sync.only.complete", {
      configPath: config.configPath,
      dbPath: config.catalog.dbPath,
    });
    return;
  }

  const interval = syncService.startIntervalSync(config.sync.intervalSeconds);
  const proxy = new ToolProxy(store, upstream);
  const mcpServer = createGatewayServer({
    store,
    proxy,
    runtime: config.runtime,
  });

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  logInfo("gateway.ready", {
    mode: "stdio",
    configPath: config.configPath,
    dbPath: config.catalog.dbPath,
  });

  const shutdown = async (): Promise<void> => {
    clearInterval(interval);
    await mcpServer.close().catch(() => undefined);
    await upstream.closeAll();
    store.close();
  };

  process.on("SIGINT", () => {
    shutdown()
      .catch((error: unknown) => {
        logError("shutdown.failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => process.exit(0));
  });

  process.on("SIGTERM", () => {
    shutdown()
      .catch((error: unknown) => {
        logError("shutdown.failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => process.exit(0));
  });
}

main().catch((error: unknown) => {
  logError("gateway.startup.failed", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
