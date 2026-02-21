import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { SourceServerConfig } from "./types.js";

interface ConnectedServer {
  config: SourceServerConfig;
  client: Client;
  transport: StreamableHTTPClientTransport;
}

export class UpstreamManager {
  private readonly serversById: Map<string, SourceServerConfig>;
  private readonly connections: Map<string, ConnectedServer>;

  public constructor(servers: SourceServerConfig[]) {
    this.serversById = new Map(servers.map((server) => [server.id, server]));
    this.connections = new Map();
  }

  public listServerConfigs(): SourceServerConfig[] {
    return Array.from(this.serversById.values());
  }

  public getServerConfig(serverId: string): SourceServerConfig | undefined {
    return this.serversById.get(serverId);
  }

  public async listTools(
    serverId: string,
  ): Promise<Awaited<ReturnType<Client["listTools"]>>["tools"]> {
    const { client } = await this.getConnection(serverId);
    const result = await client.listTools();
    return result.tools;
  }

  public async callTool(params: {
    serverId: string;
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<Awaited<ReturnType<Client["callTool"]>>> {
    const { client } = await this.getConnection(params.serverId);
    return client.callTool({
      name: params.name,
      arguments: params.arguments,
    });
  }

  public async closeAll(): Promise<void> {
    const shutdownTasks: Promise<void>[] = [];

    for (const [serverId, connection] of this.connections.entries()) {
      shutdownTasks.push(
        connection.transport
          .close()
          .catch(() => undefined)
          .finally(() => {
            this.connections.delete(serverId);
          }),
      );
    }

    await Promise.allSettled(shutdownTasks);
  }

  private async getConnection(serverId: string): Promise<ConnectedServer> {
    const existing = this.connections.get(serverId);
    if (existing) {
      return existing;
    }

    const config = this.serversById.get(serverId);
    if (!config) {
      throw new Error(`Unknown server id: ${serverId}`);
    }

    if (config.enabled === false) {
      throw new Error(`Server is disabled: ${serverId}`);
    }

    const transport = new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: buildRequestInit(config),
    });
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

    const connection: ConnectedServer = {
      config,
      client,
      transport,
    };

    this.connections.set(serverId, connection);
    return connection;
  }
}

function buildRequestInit(config: SourceServerConfig): RequestInit {
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
