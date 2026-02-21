import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface HttpTransportConfig {
  host: string;
  port: number;
}

export interface RunningHttpTransport {
  endpointUrl: string;
  close: () => Promise<void>;
}

export async function startHttpTransport(
  server: McpServer,
  config: HttpTransportConfig,
): Promise<RunningHttpTransport> {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  await server.connect(transport);

  const nodeServer = http.createServer((req, res) => {
    void handleRequest(transport, req, res);
  });

  await new Promise<void>((resolve, reject) => {
    nodeServer.once("error", reject);
    nodeServer.listen(config.port, config.host, () => {
      nodeServer.off("error", reject);
      resolve();
    });
  });

  return {
    endpointUrl: `http://${config.host}:${config.port}/mcp`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        nodeServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });

      await transport.close().catch(() => undefined);
    },
  };
}

async function handleRequest(
  transport: StreamableHTTPServerTransport,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  try {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname === "/healthz") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (url.pathname !== "/mcp") {
      res.statusCode = 404;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          error: "Not Found",
          expectedPaths: ["/mcp", "/healthz"],
        }),
      );
      return;
    }

    if (method !== "POST" && method !== "GET" && method !== "DELETE") {
      res.statusCode = 405;
      res.setHeader("allow", "GET, POST, DELETE");
      res.end("Method Not Allowed");
      return;
    }

    await transport.handleRequest(req, res);
  } catch (error: unknown) {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          error: "Internal Server Error",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      return;
    }

    try {
      res.end();
    } catch {
      // no-op
    }
  }
}
