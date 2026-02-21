import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { CatalogStore } from "./catalog-store.js";
import { ToolProxy } from "./proxy.js";
import { createCatalogApi, createExecuteApi } from "./runtime-apis.js";
import { normalizeExecuteOutput } from "./execute-output.js";
import { runSandboxedCode, serializeWithLimit } from "./sandbox.js";
import type { RuntimeSettings } from "./types.js";

export function createGatewayServer(options: {
  store: CatalogStore;
  proxy: ToolProxy;
  runtime: RuntimeSettings;
}): McpServer {
  const server = new McpServer({
    name: "thinmcp-gateway",
    version: "0.1.0",
  });

  server.registerTool(
    "search",
    {
      title: "Search",
      description:
        "Search synced MCP tools by running JavaScript against a read-only catalog API.",
      inputSchema: {
        code: z
          .string()
          .describe(
            "JavaScript async arrow function. Available global: catalog (listServers, findTools, getTool).",
          ),
      },
    },
    async ({ code }) => {
      try {
        const catalogApi = createCatalogApi(options.store);
        const result = await runSandboxedCode<unknown>({
          code,
          timeoutMs: options.runtime.codeTimeoutMs,
          maxCodeLength: options.runtime.maxCodeLength,
          globals: {
            catalog: catalogApi,
          },
        });

        const text = serializeWithLimit(result, options.runtime.maxResultChars);

        return {
          content: [{ type: "text", text }],
          structuredContent: {
            result,
          },
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [{ type: "text", text: `search() failed: ${message}` }],
        };
      }
    },
  );

  server.registerTool(
    "execute",
    {
      title: "Execute",
      description:
        "Execute JavaScript that calls upstream MCP tools through thinmcp.tool.call().",
      inputSchema: {
        code: z
          .string()
          .describe(
            "JavaScript async arrow function. Available global: tool.call({serverId, name, arguments}).",
          ),
      },
    },
    async ({ code }) => {
      try {
        const executeApi = createExecuteApi(options.proxy);
        const result = await runSandboxedCode<unknown>({
          code,
          timeoutMs: options.runtime.codeTimeoutMs,
          maxCodeLength: options.runtime.maxCodeLength,
          globals: {
            tool: executeApi.tool,
          },
        });
        const normalizedResult = normalizeExecuteOutput(result);

        const text = serializeWithLimit(
          normalizedResult,
          options.runtime.maxResultChars,
        );

        return {
          content: [{ type: "text", text }],
          structuredContent: {
            result: normalizedResult,
          },
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [{ type: "text", text: `execute() failed: ${message}` }],
        };
      }
    },
  );

  return server;
}
