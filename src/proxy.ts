import type { ExecuteToolInput } from "./types.js";
import { CatalogStore } from "./catalog-store.js";
import { UpstreamManager } from "./upstream-manager.js";
import { logInfo } from "./logger.js";

interface ToolProxyOptions {
  refreshServer?: (serverId: string) => Promise<void>;
}

export class ToolProxy {
  private readonly store: CatalogStore;
  private readonly upstream: UpstreamManager;
  private readonly refreshServer?: (serverId: string) => Promise<void>;

  public constructor(
    store: CatalogStore,
    upstream: UpstreamManager,
    options?: ToolProxyOptions,
  ) {
    this.store = store;
    this.upstream = upstream;
    this.refreshServer = options?.refreshServer;
  }

  public async call(input: ExecuteToolInput): Promise<unknown> {
    const server = this.store.listServers().find((row) => row.id === input.serverId);
    if (!server) {
      throw new Error(`Unknown server: ${input.serverId}`);
    }

    if (!server.enabled) {
      throw new Error(`Server is disabled: ${input.serverId}`);
    }

    if (!isToolAllowed(input.name, server.allowTools)) {
      throw new Error(
        `Tool '${input.name}' is blocked by allowTools for server '${input.serverId}'`,
      );
    }

    let knownTool = this.store.getTool(input.serverId, input.name);
    if (!knownTool) {
      if (this.refreshServer) {
        logInfo("proxy.refresh.start", {
          serverId: input.serverId,
          reason: "tool_not_found_locally",
          toolName: input.name,
        });
        await this.refreshServer(input.serverId);
        knownTool = this.store.getTool(input.serverId, input.name);
      }

      if (!knownTool) {
        throw new Error(
          `Tool '${input.name}' not found in local catalog for server '${input.serverId}'.`,
        );
      }
    }

    return this.upstream.callTool({
      serverId: input.serverId,
      name: input.name,
      ...(input.arguments ? { arguments: input.arguments } : {}),
    });
  }
}

function isToolAllowed(name: string, allowList: string[]): boolean {
  if (allowList.includes("*")) {
    return true;
  }

  for (const item of allowList) {
    if (item === name) {
      return true;
    }

    if (item.endsWith("*") && name.startsWith(item.slice(0, -1))) {
      return true;
    }
  }

  return false;
}
