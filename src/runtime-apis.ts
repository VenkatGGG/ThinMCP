import { CatalogStore } from "./catalog-store.js";
import { ToolProxy } from "./proxy.js";
import type { ExecuteToolInput, SearchQuery } from "./types.js";

export interface CatalogApi {
  listServers: () => Array<{
    id: string;
    name: string;
    url: string;
    enabled: boolean;
    lastSyncedAt: string | null;
  }>;
  findTools: (query: SearchQuery) => Array<{
    serverId: string;
    serverName: string;
    serverUrl: string;
    toolName: string;
    title: string | null;
    description: string;
    inputSchema: Record<string, unknown>;
    outputSchema: Record<string, unknown> | null;
    annotations: Record<string, unknown> | null;
    snapshotHash: string;
  }>;
  getTool: (serverId: string, toolName: string) => {
    serverId: string;
    serverName: string;
    serverUrl: string;
    toolName: string;
    title: string | null;
    description: string;
    inputSchema: Record<string, unknown>;
    outputSchema: Record<string, unknown> | null;
    annotations: Record<string, unknown> | null;
    snapshotHash: string;
  } | null;
}

export interface ExecuteApi {
  tool: {
    call: (input: ExecuteToolInput) => Promise<unknown>;
  };
}

export function createCatalogApi(store: CatalogStore): CatalogApi {
  return {
    listServers: () => {
      return store.listServers().map((server) => ({
        id: server.id,
        name: server.name,
        url: server.url,
        enabled: server.enabled,
        lastSyncedAt: server.lastSyncedAt,
      }));
    },
    findTools: (query: SearchQuery) => {
      return store.searchTools(query).map((tool) => ({
        serverId: tool.serverId,
        serverName: tool.serverName,
        serverUrl: tool.serverUrl,
        toolName: tool.toolName,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
        snapshotHash: tool.snapshotHash,
      }));
    },
    getTool: (serverId: string, toolName: string) => {
      const tool = store.getTool(serverId, toolName);
      if (!tool) {
        return null;
      }

      return {
        serverId: tool.serverId,
        serverName: tool.serverName,
        serverUrl: tool.serverUrl,
        toolName: tool.toolName,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
        snapshotHash: tool.snapshotHash,
      };
    },
  };
}

export function createExecuteApi(proxy: ToolProxy): ExecuteApi {
  return {
    tool: {
      call: async (input: ExecuteToolInput) => {
        return proxy.call(input);
      },
    },
  };
}
