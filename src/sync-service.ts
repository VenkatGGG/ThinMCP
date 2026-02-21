import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { CatalogSettings, NormalizedToolRecord, SourceServerConfig } from "./types.js";
import { CatalogStore } from "./catalog-store.js";
import { logError, logInfo } from "./logger.js";
import { UpstreamManager } from "./upstream-manager.js";

export interface SyncRunSummary {
  serverId: string;
  toolCount: number;
  snapshotHash: string;
  snapshotPath: string;
}

export class SyncService {
  private readonly store: CatalogStore;
  private readonly upstream: UpstreamManager;
  private readonly settings: CatalogSettings;

  public constructor(
    store: CatalogStore,
    upstream: UpstreamManager,
    settings: CatalogSettings,
  ) {
    this.store = store;
    this.upstream = upstream;
    this.settings = settings;

    fs.mkdirSync(this.settings.snapshotDir, { recursive: true });
  }

  public async syncAllServers(): Promise<SyncRunSummary[]> {
    const servers = this.upstream
      .listServerConfigs()
      .filter((server) => server.enabled !== false);

    const summaries: SyncRunSummary[] = [];

    for (const server of servers) {
      const summary = await this.syncServer(server);
      summaries.push(summary);
    }

    return summaries;
  }

  public async syncServer(server: SourceServerConfig): Promise<SyncRunSummary> {
    logInfo("sync.start", { serverId: server.id, url: server.url });

    const tools = await this.upstream.listTools(server.id);
    const snapshotPayload = {
      fetchedAt: new Date().toISOString(),
      server,
      tools,
    };
    const serialized = JSON.stringify(snapshotPayload);
    const snapshotHash = hashPayload(serialized);
    const snapshotPath = writeSnapshot(
      this.settings.snapshotDir,
      server.id,
      snapshotHash,
      serialized,
    );
    const normalizedTools = normalizeTools(server, tools, snapshotHash);

    this.store.replaceServerTools(
      server.id,
      snapshotHash,
      snapshotPath,
      normalizedTools,
    );

    logInfo("sync.complete", {
      serverId: server.id,
      snapshotHash,
      toolCount: normalizedTools.length,
    });

    return {
      serverId: server.id,
      toolCount: normalizedTools.length,
      snapshotHash,
      snapshotPath,
    };
  }

  public startIntervalSync(intervalSeconds: number): NodeJS.Timeout {
    const millis = Math.max(10, intervalSeconds) * 1000;

    return setInterval(() => {
      this.syncAllServers().catch((error: unknown) => {
        logError("sync.interval.failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, millis);
  }
}

function normalizeTools(
  server: SourceServerConfig,
  tools: Awaited<ReturnType<UpstreamManager["listTools"]>>,
  snapshotHash: string,
): NormalizedToolRecord[] {
  return tools.map((tool) => {
    const description = tool.description ?? "";
    const title = tool.title ?? null;
    const searchableText = [
      tool.name,
      title,
      description,
      JSON.stringify(tool.inputSchema ?? {}),
      JSON.stringify(tool.annotations ?? {}),
    ]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .join(" ")
      .toLowerCase();

    return {
      serverId: server.id,
      serverName: server.name ?? server.id,
      serverUrl: server.url,
      toolName: tool.name,
      title,
      description,
      inputSchema: sanitizeObject(tool.inputSchema) ?? {},
      outputSchema: sanitizeObject(tool.outputSchema),
      annotations: sanitizeObject(tool.annotations),
      searchableText,
      snapshotHash,
    };
  });
}

function sanitizeObject(
  value: unknown,
): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function hashPayload(payload: string): string {
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

function writeSnapshot(
  baseDir: string,
  serverId: string,
  hash: string,
  payload: string,
): string {
  const serverDir = path.join(baseDir, serverId);
  fs.mkdirSync(serverDir, { recursive: true });

  const fileName = `${new Date().toISOString().replace(/[.:]/g, "-")}-${hash}.json`;
  const fullPath = path.join(serverDir, fileName);
  fs.writeFileSync(fullPath, payload, "utf8");

  return fullPath;
}
