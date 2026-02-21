import { loadConfig } from "./config.js";
import { logInfo } from "./logger.js";

function main(): void {
  const config = loadConfig();

  logInfo("doctor.config.loaded", {
    configPath: config.configPath,
    serverCount: config.servers.length,
    dbPath: config.catalog.dbPath,
    snapshotDir: config.catalog.snapshotDir,
  });

  for (const server of config.servers) {
    const enabled = server.enabled !== false;
    const allowTools = server.allowTools ?? ["*"];

    if (server.auth?.type === "bearer_env") {
      const hasToken = Boolean(process.env[server.auth.env]);
      logInfo("doctor.server", {
        id: server.id,
        enabled,
        transport: server.transport,
        url: server.url,
        authType: server.auth.type,
        authEnv: server.auth.env,
        authEnvPresent: hasToken,
        allowTools,
      });
      continue;
    }

    logInfo("doctor.server", {
      id: server.id,
      enabled,
      transport: server.transport,
      url: server.url,
      authType: server.auth?.type ?? "none",
      allowTools,
    });
  }
}

main();
