import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CatalogStore } from "./catalog-store.js";
import { loadConfig } from "./config.js";
import { createGatewayServer } from "./gateway-server.js";
import { startHttpTransport } from "./http-transport.js";
import { logError, logInfo } from "./logger.js";
import { ToolProxy } from "./proxy.js";
import { SyncService } from "./sync-service.js";
import { UpstreamManager } from "./upstream-manager.js";

async function main(): Promise<void> {
  const syncOnly = process.argv.includes("--sync-only");
  const serverFilter = readArgValue("--server");
  const transportMode = (readArgValue("--transport") ?? "stdio").toLowerCase();
  const port = readPortArg("--port", 8787);
  const host = readArgValue("--host") ?? "127.0.0.1";
  const httpAuthToken = resolveHttpAuthToken();
  const httpRateLimit = readIntArg("--http-rate-limit", 120);
  const httpRateWindowSeconds = readIntArg("--http-rate-window-seconds", 60);

  const config = loadConfig();

  const store = new CatalogStore(config.catalog.dbPath);
  store.upsertServers(config.servers);

  const upstream = new UpstreamManager(config.servers);
  const syncService = new SyncService(store, upstream, config.catalog);

  if (config.sync.onStart || syncOnly) {
    if (serverFilter) {
      const server = upstream.getServerConfig(serverFilter);
      if (!server) {
        throw new Error(`Unknown --server value '${serverFilter}' in current config.`);
      }

      await syncService.syncServer(server);
    } else {
      await syncService.syncAllServers();
    }
  }

  if (syncOnly) {
    await upstream.closeAll();
    store.close();
    logInfo("sync.only.complete", {
      configPath: config.configPath,
      dbPath: config.catalog.dbPath,
      ...(serverFilter ? { serverId: serverFilter } : {}),
    });
    return;
  }

  const interval = syncService.startIntervalSync(config.sync.intervalSeconds);
  const proxy = new ToolProxy(store, upstream, {
    refreshServer: async (serverId) => {
      const server = upstream.getServerConfig(serverId);
      if (!server) {
        return;
      }

      await syncService.syncServer(server);
    },
  });
  const mcpServer = createGatewayServer({
    store,
    proxy,
    runtime: config.runtime,
  });

  let extraShutdown: (() => Promise<void>) | undefined;
  if (transportMode === "stdio") {
    const transport = new StdioServerTransport();
    await mcpServer.connect(transport);

    logInfo("gateway.ready", {
      mode: "stdio",
      configPath: config.configPath,
      dbPath: config.catalog.dbPath,
    });
  } else if (transportMode === "http") {
    const httpTransport = await startHttpTransport(mcpServer, {
      host,
      port,
      ...(httpAuthToken ? { authToken: httpAuthToken } : {}),
      rateLimit: {
        maxRequests: httpRateLimit,
        windowSeconds: httpRateWindowSeconds,
      },
    });
    extraShutdown = httpTransport.close;

    logInfo("gateway.ready", {
      mode: "http",
      endpoint: httpTransport.endpointUrl,
      healthz: `http://${host}:${port}/healthz`,
      authEnabled: Boolean(httpAuthToken),
      rateLimit: httpRateLimit,
      rateWindowSeconds: httpRateWindowSeconds,
      configPath: config.configPath,
      dbPath: config.catalog.dbPath,
    });
  } else {
    throw new Error(
      `Invalid --transport value '${transportMode}'. Use 'stdio' or 'http'.`,
    );
  }

  const shutdown = async (): Promise<void> => {
    clearInterval(interval);
    if (extraShutdown) {
      await extraShutdown().catch(() => undefined);
    }
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

function readArgValue(flag: string): string | null {
  const index = process.argv.findIndex((arg) => arg === flag);
  if (index < 0) {
    return null;
  }

  const nextValue = process.argv[index + 1];
  if (!nextValue || nextValue.startsWith("-")) {
    throw new Error(`Missing value after '${flag}'`);
  }

  return nextValue;
}

function readPortArg(flag: string, fallback: number): number {
  const value = readArgValue(flag);
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid port value '${value}' for '${flag}'`);
  }

  return parsed;
}

function readIntArg(flag: string, fallback: number): number {
  const value = readArgValue(flag);
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid numeric value '${value}' for '${flag}'`);
  }

  return parsed;
}

function resolveHttpAuthToken(): string | undefined {
  const tokenFromFlag = readArgValue("--http-auth-token");
  if (tokenFromFlag) {
    return tokenFromFlag;
  }

  const tokenEnvName = readArgValue("--http-auth-token-env");
  if (tokenEnvName) {
    const token = process.env[tokenEnvName];
    if (!token) {
      throw new Error(
        `Missing env token from --http-auth-token-env '${tokenEnvName}'`,
      );
    }

    return token;
  }

  return process.env.THINMCP_HTTP_TOKEN;
}
