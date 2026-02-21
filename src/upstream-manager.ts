import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { logInfo, logWarn } from "./logger.js";
import type {
  HttpSourceServerConfig,
  SourceServerConfig,
  StdioSourceServerConfig,
} from "./types.js";

interface ConnectedServer {
  config: SourceServerConfig;
  client: Client;
  transport: Transport;
}

export interface UpstreamManagerOptions {
  stdio?: {
    maxRetries?: number;
    baseBackoffMs?: number;
    maxBackoffMs?: number;
  };
}

export interface ServerHealthSnapshot {
  serverId: string;
  transport: SourceServerConfig["transport"];
  enabled: boolean;
  status: "disabled" | "healthy" | "degraded" | "down";
  connected: boolean;
  totalCalls: number;
  successfulCalls: number;
  failedCalls: number;
  consecutiveFailures: number;
  restarts: number;
  lastError: string | null;
  lastConnectedAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  nextRetryAt: string | null;
}

interface ServerHealthState {
  serverId: string;
  transport: SourceServerConfig["transport"];
  enabled: boolean;
  connected: boolean;
  totalCalls: number;
  successfulCalls: number;
  failedCalls: number;
  consecutiveFailures: number;
  restarts: number;
  lastError: string | null;
  lastConnectedAtMs: number | null;
  lastSuccessAtMs: number | null;
  lastFailureAtMs: number | null;
  nextRetryAtMs: number | null;
}

export class UpstreamManager {
  private readonly serversById: Map<string, SourceServerConfig>;
  private readonly connections: Map<string, ConnectedServer>;
  private readonly connecting: Map<string, Promise<ConnectedServer>>;
  private readonly healthByServer: Map<string, ServerHealthState>;
  private readonly stdioPolicy: {
    maxRetries: number;
    baseBackoffMs: number;
    maxBackoffMs: number;
  };

  public constructor(servers: SourceServerConfig[], options?: UpstreamManagerOptions) {
    this.serversById = new Map(servers.map((server) => [server.id, server]));
    this.connections = new Map();
    this.connecting = new Map();
    this.healthByServer = new Map(
      servers.map((server) => [server.id, createInitialHealth(server)]),
    );
    this.stdioPolicy = {
      maxRetries: Math.max(0, options?.stdio?.maxRetries ?? 3),
      baseBackoffMs: Math.max(25, options?.stdio?.baseBackoffMs ?? 250),
      maxBackoffMs: Math.max(250, options?.stdio?.maxBackoffMs ?? 4_000),
    };
  }

  public listServerConfigs(): SourceServerConfig[] {
    return Array.from(this.serversById.values());
  }

  public getServerConfig(serverId: string): SourceServerConfig | undefined {
    return this.serversById.get(serverId);
  }

  public getHealthSnapshot(): ServerHealthSnapshot[] {
    return Array.from(this.healthByServer.values())
      .sort((a, b) => a.serverId.localeCompare(b.serverId))
      .map((state) => mapHealthState(state));
  }

  public async listTools(
    serverId: string,
  ): Promise<Awaited<ReturnType<Client["listTools"]>>["tools"]> {
    return this.withServerOperation(serverId, async (client) => {
      const result = await client.listTools();
      return result.tools;
    });
  }

  public async callTool(params: {
    serverId: string;
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<Awaited<ReturnType<Client["callTool"]>>> {
    return this.withServerOperation(params.serverId, (client) => {
      return client.callTool({
        name: params.name,
        arguments: params.arguments,
      });
    });
  }

  public async closeAll(): Promise<void> {
    const shutdownTasks: Promise<void>[] = [];

    for (const serverId of this.connections.keys()) {
      shutdownTasks.push(this.disposeConnection(serverId));
    }

    await Promise.allSettled(shutdownTasks);
    this.connecting.clear();
  }

  private async withServerOperation<T>(
    serverId: string,
    operation: (client: Client) => Promise<T>,
  ): Promise<T> {
    const config = this.getServerOrThrow(serverId);
    const health = this.getHealthOrThrow(serverId);

    if (!health.enabled) {
      throw new Error(`Server is disabled: ${serverId}`);
    }

    health.totalCalls += 1;

    const maxAttempts =
      config.transport === "stdio" ? this.stdioPolicy.maxRetries + 1 : 1;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        if (config.transport === "stdio") {
          await this.waitIfBackoffActive(serverId);
        }

        const connection = await this.getConnection(serverId);
        const result = await operation(connection.client);

        this.markSuccess(serverId);
        return result;
      } catch (error: unknown) {
        const normalized =
          error instanceof Error ? error : new Error(String(error));
        lastError = normalized;

        this.markFailure(serverId, normalized.message);
        await this.disposeConnection(serverId);

        const shouldRetry =
          config.transport === "stdio" && attempt < maxAttempts;
        if (!shouldRetry) {
          break;
        }

        const delayMs = this.computeBackoffMs(health.consecutiveFailures);
        health.nextRetryAtMs = Date.now() + delayMs;
        health.restarts += 1;
        logWarn("upstream.stdio.retry", {
          serverId,
          attempt,
          maxAttempts,
          delayMs,
          error: normalized.message,
        });

        await sleep(delayMs);
      }
    }

    if (lastError) {
      throw lastError;
    }

    throw new Error(`Operation failed for server '${serverId}'`);
  }

  private async getConnection(serverId: string): Promise<ConnectedServer> {
    const existing = this.connections.get(serverId);
    if (existing) {
      return existing;
    }

    const inflight = this.connecting.get(serverId);
    if (inflight) {
      return inflight;
    }

    const config = this.getServerOrThrow(serverId);
    const health = this.getHealthOrThrow(serverId);
    if (!health.enabled) {
      throw new Error(`Server is disabled: ${serverId}`);
    }

    const promise = (async () => {
      if (config.transport === "stdio") {
        await this.waitIfBackoffActive(serverId);
      }

      const transport = buildTransport(config);
      const client = new Client(
        {
          name: "thinmcp-upstream-client",
          version: "0.1.0",
        },
        {
          capabilities: {},
        },
      );

      try {
        await client.connect(transport);
      } catch (error) {
        await transport.close().catch(() => undefined);
        throw error;
      }

      transport.onclose = () => {
        this.connections.delete(serverId);
        const state = this.healthByServer.get(serverId);
        if (state) {
          state.connected = false;
        }
      };

      transport.onerror = (error: Error) => {
        const state = this.healthByServer.get(serverId);
        if (state) {
          state.lastError = error.message;
        }
      };

      const connection: ConnectedServer = {
        config,
        client,
        transport,
      };

      this.connections.set(serverId, connection);

      health.connected = true;
      health.lastConnectedAtMs = Date.now();
      return connection;
    })();

    this.connecting.set(serverId, promise);

    try {
      return await promise;
    } finally {
      this.connecting.delete(serverId);
    }
  }

  private async disposeConnection(serverId: string): Promise<void> {
    const connection = this.connections.get(serverId);
    if (!connection) {
      return;
    }

    this.connections.delete(serverId);
    await connection.transport.close().catch(() => undefined);

    const health = this.healthByServer.get(serverId);
    if (health) {
      health.connected = false;
    }
  }

  private markSuccess(serverId: string): void {
    const health = this.getHealthOrThrow(serverId);
    health.successfulCalls += 1;
    health.consecutiveFailures = 0;
    health.lastError = null;
    health.lastSuccessAtMs = Date.now();
    health.nextRetryAtMs = null;
  }

  private markFailure(serverId: string, errorMessage: string): void {
    const health = this.getHealthOrThrow(serverId);
    health.failedCalls += 1;
    health.consecutiveFailures += 1;
    health.lastFailureAtMs = Date.now();
    health.lastError = errorMessage;
  }

  private computeBackoffMs(consecutiveFailures: number): number {
    const exp = Math.max(0, consecutiveFailures - 1);
    const raw = this.stdioPolicy.baseBackoffMs * Math.pow(2, exp);
    return Math.min(this.stdioPolicy.maxBackoffMs, Math.trunc(raw));
  }

  private async waitIfBackoffActive(serverId: string): Promise<void> {
    const health = this.getHealthOrThrow(serverId);
    if (!health.nextRetryAtMs) {
      return;
    }

    const delayMs = health.nextRetryAtMs - Date.now();
    if (delayMs <= 0) {
      health.nextRetryAtMs = null;
      return;
    }

    await sleep(delayMs);
    health.nextRetryAtMs = null;
  }

  private getServerOrThrow(serverId: string): SourceServerConfig {
    const server = this.serversById.get(serverId);
    if (!server) {
      throw new Error(`Unknown server id: ${serverId}`);
    }

    return server;
  }

  private getHealthOrThrow(serverId: string): ServerHealthState {
    const health = this.healthByServer.get(serverId);
    if (!health) {
      throw new Error(`Missing health state for server id: ${serverId}`);
    }

    return health;
  }
}

function buildTransport(config: SourceServerConfig): Transport {
  if (config.transport === "http") {
    return new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: buildRequestInit(config),
    });
  }

  return new StdioClientTransport(buildStdioServerParams(config));
}

function buildRequestInit(config: HttpSourceServerConfig): RequestInit {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };

  if (config.auth?.type === "bearer_env") {
    const token = process.env[config.auth.env];
    if (!token) {
      throw new Error(
        `Missing env token for ${config.id}. Set ${config.auth.env} before startup.`,
      );
    }

    headers.authorization = `Bearer ${token}`;
  }

  return {
    headers,
  };
}

function buildStdioServerParams(config: StdioSourceServerConfig): {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stderr?: "inherit" | "pipe";
} {
  return {
    command: config.command,
    ...(config.args && config.args.length > 0 ? { args: config.args } : {}),
    ...(config.cwd ? { cwd: config.cwd } : {}),
    ...(config.env ? { env: config.env } : {}),
    ...(config.stderr ? { stderr: config.stderr } : {}),
  };
}

function createInitialHealth(server: SourceServerConfig): ServerHealthState {
  return {
    serverId: server.id,
    transport: server.transport,
    enabled: server.enabled !== false,
    connected: false,
    totalCalls: 0,
    successfulCalls: 0,
    failedCalls: 0,
    consecutiveFailures: 0,
    restarts: 0,
    lastError: null,
    lastConnectedAtMs: null,
    lastSuccessAtMs: null,
    lastFailureAtMs: null,
    nextRetryAtMs: null,
  };
}

function mapHealthState(state: ServerHealthState): ServerHealthSnapshot {
  return {
    serverId: state.serverId,
    transport: state.transport,
    enabled: state.enabled,
    status: deriveStatus(state),
    connected: state.connected,
    totalCalls: state.totalCalls,
    successfulCalls: state.successfulCalls,
    failedCalls: state.failedCalls,
    consecutiveFailures: state.consecutiveFailures,
    restarts: state.restarts,
    lastError: state.lastError,
    lastConnectedAt: state.lastConnectedAtMs ? new Date(state.lastConnectedAtMs).toISOString() : null,
    lastSuccessAt: state.lastSuccessAtMs ? new Date(state.lastSuccessAtMs).toISOString() : null,
    lastFailureAt: state.lastFailureAtMs ? new Date(state.lastFailureAtMs).toISOString() : null,
    nextRetryAt: state.nextRetryAtMs ? new Date(state.nextRetryAtMs).toISOString() : null,
  };
}

function deriveStatus(
  state: ServerHealthState,
): "disabled" | "healthy" | "degraded" | "down" {
  if (!state.enabled) {
    return "disabled";
  }

  if (state.connected && state.consecutiveFailures === 0) {
    return "healthy";
  }

  if (state.consecutiveFailures === 0) {
    return "degraded";
  }

  if (state.consecutiveFailures >= 3) {
    return "down";
  }

  return "degraded";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(1, ms)));
}
