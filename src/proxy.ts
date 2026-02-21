import type { ExecuteToolInput } from "./types.js";
import { CatalogStore } from "./catalog-store.js";
import { UpstreamManager } from "./upstream-manager.js";
import { logInfo } from "./logger.js";
import { ToolInputValidator } from "./schema-validator.js";

interface ToolProxyOptions {
  refreshServer?: (serverId: string) => Promise<void>;
}

export class ToolProxy {
  private readonly store: CatalogStore;
  private readonly upstream: UpstreamManager;
  private readonly refreshServer?: (serverId: string) => Promise<void>;
  private readonly inputValidator: ToolInputValidator;

  public constructor(
    store: CatalogStore,
    upstream: UpstreamManager,
    options?: ToolProxyOptions,
  ) {
    this.store = store;
    this.upstream = upstream;
    this.refreshServer = options?.refreshServer;
    this.inputValidator = new ToolInputValidator();
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

    await this.validateInputWithRefresh(knownTool, input.arguments);

    return this.upstream.callTool({
      serverId: input.serverId,
      name: input.name,
      ...(input.arguments ? { arguments: input.arguments } : {}),
    });
  }

  private async validateInputWithRefresh(
    knownTool: NonNullable<ReturnType<CatalogStore["getTool"]>>,
    args: Record<string, unknown> | undefined,
  ): Promise<void> {
    try {
      this.inputValidator.validate(knownTool, args);
      return;
    } catch (firstError: unknown) {
      if (!this.refreshServer) {
        throw firstError;
      }

      logInfo("proxy.refresh.start", {
        serverId: knownTool.serverId,
        reason: "input_validation_failed",
        toolName: knownTool.toolName,
      });

      await this.refreshServer(knownTool.serverId);
      const refreshedTool = this.store.getTool(knownTool.serverId, knownTool.toolName);
      if (!refreshedTool) {
        throw firstError;
      }

      this.inputValidator.validate(refreshedTool, args);
    }
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
