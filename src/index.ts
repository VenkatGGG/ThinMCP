import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CatalogStore } from "./catalog-store.js";
import { loadConfig } from "./config.js";
import { createGatewayServer } from "./gateway-server.js";
import { HttpAuthenticator, type HttpAuthConfig } from "./http-auth.js";
import { startHttpTransport } from "./http-transport.js";
import { logError, logInfo } from "./logger.js";
import { ToolProxy } from "./proxy.js";
import { createRedisRateLimiter, type RateLimiter } from "./rate-limit.js";
import { SyncService } from "./sync-service.js";
import { UpstreamManager } from "./upstream-manager.js";

async function main(): Promise<void> {
  const syncOnly = process.argv.includes("--sync-only");
  const serverFilter = readArgValue("--server");
  const transportMode = (readArgValue("--transport") ?? "stdio").toLowerCase();
  const port = readPortArg("--port", 8787);
  const host = readArgValue("--host") ?? "127.0.0.1";
  const httpAuthConfig = resolveHttpAuthConfig();
  const redisUrl = readArgValue("--redis-url") ?? process.env.THINMCP_REDIS_URL;
  const rateNamespace =
    readArgValue("--redis-rate-namespace") ??
    process.env.THINMCP_REDIS_RATE_NAMESPACE ??
    "thinmcp:ratelimit";
  const httpRateLimit = readIntArg("--http-rate-limit", 0);
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
  let sharedRateLimiter: RateLimiter | undefined;
  if (transportMode === "stdio") {
    const transport = new StdioServerTransport();
    await mcpServer.connect(transport);

    logInfo("gateway.ready", {
      mode: "stdio",
      configPath: config.configPath,
      dbPath: config.catalog.dbPath,
    });
  } else if (transportMode === "http") {
    if (httpRateLimit > 0 && !redisUrl) {
      throw new Error(
        "HTTP rate limiting requires Redis. Set --redis-url or THINMCP_REDIS_URL.",
      );
    }

    if (httpRateLimit > 0 && redisUrl) {
      sharedRateLimiter = await createRedisRateLimiter({
        redisUrl,
        maxRequests: httpRateLimit,
        windowSeconds: httpRateWindowSeconds,
        namespace: rateNamespace,
      });
    }

    const startedAt = new Date().toISOString();
    const httpTransport = await startHttpTransport(mcpServer, {
      host,
      port,
      authenticator: new HttpAuthenticator(httpAuthConfig),
      ...(sharedRateLimiter ? { rateLimiter: sharedRateLimiter } : {}),
      healthProvider: async () => ({
        ok: true,
        startedAt,
        authMode: httpAuthConfig.mode,
        rateLimitEnabled: Boolean(sharedRateLimiter),
        upstream: upstream.getHealthSnapshot(),
      }),
      metricsProvider: async () => ({
        startedAt,
        authMode: httpAuthConfig.mode,
        rateLimit: {
          enabled: Boolean(sharedRateLimiter),
          maxRequests: httpRateLimit,
          windowSeconds: httpRateWindowSeconds,
          namespace: rateNamespace,
        },
        upstream: upstream.getHealthSnapshot(),
      }),
    });
    extraShutdown = httpTransport.close;

    logInfo("gateway.ready", {
      mode: "http",
      endpoint: httpTransport.endpointUrl,
      healthz: `http://${host}:${port}/healthz`,
      metrics: `http://${host}:${port}/metrics`,
      authMode: httpAuthConfig.mode,
      rateLimit: httpRateLimit,
      rateWindowSeconds: httpRateWindowSeconds,
      rateBackend: sharedRateLimiter ? "redis" : "disabled",
      redisConfigured: Boolean(redisUrl),
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
    if (sharedRateLimiter) {
      await sharedRateLimiter.close().catch(() => undefined);
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

function resolveHttpAuthConfig(): HttpAuthConfig {
  const explicitMode =
    (readArgValue("--http-auth-mode") ??
      process.env.THINMCP_HTTP_AUTH_MODE ??
      "").trim().toLowerCase();

  const jwtJwksUrl =
    readArgValue("--http-jwt-jwks-url") ?? process.env.THINMCP_HTTP_JWKS_URL;
  const jwtIssuer =
    readArgValue("--http-jwt-issuer") ?? process.env.THINMCP_HTTP_ISSUER;
  const jwtAudience =
    readArgValue("--http-jwt-audience") ?? process.env.THINMCP_HTTP_AUDIENCE;
  const jwtAlgorithms = readCsvArg(
    "--http-jwt-algorithms",
    process.env.THINMCP_HTTP_JWT_ALGORITHMS,
  );

  const token = resolveHttpAuthToken();

  if (explicitMode === "none") {
    return { mode: "none" };
  }

  if (explicitMode === "bearer") {
    if (!token) {
      throw new Error(
        "HTTP bearer auth mode requires --http-auth-token, --http-auth-token-env, or THINMCP_HTTP_TOKEN.",
      );
    }

    return {
      mode: "bearer",
      token,
    };
  }

  if (explicitMode === "jwt") {
    if (!jwtJwksUrl) {
      throw new Error(
        "HTTP JWT auth mode requires --http-jwt-jwks-url or THINMCP_HTTP_JWKS_URL.",
      );
    }

    return {
      mode: "jwt",
      jwksUrl: jwtJwksUrl,
      ...(jwtIssuer ? { issuer: jwtIssuer } : {}),
      ...(jwtAudience ? { audience: jwtAudience } : {}),
      ...(jwtAlgorithms.length > 0 ? { algorithms: jwtAlgorithms } : {}),
    };
  }

  if (explicitMode.length > 0) {
    throw new Error(
      `Invalid --http-auth-mode value '${explicitMode}'. Use none, bearer, or jwt.`,
    );
  }

  if (jwtJwksUrl) {
    return {
      mode: "jwt",
      jwksUrl: jwtJwksUrl,
      ...(jwtIssuer ? { issuer: jwtIssuer } : {}),
      ...(jwtAudience ? { audience: jwtAudience } : {}),
      ...(jwtAlgorithms.length > 0 ? { algorithms: jwtAlgorithms } : {}),
    };
  }

  if (token) {
    return {
      mode: "bearer",
      token,
    };
  }

  return { mode: "none" };
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

function readCsvArg(flag: string, fallback?: string): string[] {
  const value = readArgValue(flag);
  const selected = value ?? fallback;
  if (!selected) {
    return [];
  }

  return selected
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}
