import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HttpAuthenticator } from "./http-auth.js";
import type { RateLimiter } from "./rate-limit.js";

export interface HttpTransportConfig {
  host: string;
  port: number;
  authenticator: HttpAuthenticator;
  rateLimiter?: RateLimiter;
  healthProvider?: () => Promise<Record<string, unknown>> | Record<string, unknown>;
  metricsProvider?: () => Promise<Record<string, unknown>> | Record<string, unknown>;
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
    void handleRequest(transport, req, res, config);
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
  options: HttpTransportConfig,
): Promise<void> {
  try {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname === "/healthz") {
      const payload = options.healthProvider
        ? await options.healthProvider()
        : { ok: true };
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(payload));
      return;
    }

    if (url.pathname === "/metrics") {
      const payload = options.metricsProvider
        ? await options.metricsProvider()
        : { ok: true };
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(payload));
      return;
    }

    if (url.pathname !== "/mcp") {
      res.statusCode = 404;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          error: "Not Found",
          expectedPaths: ["/mcp", "/healthz", "/metrics"],
        }),
      );
      return;
    }

    const authVerdict = await options.authenticator.authorize(req.headers.authorization);
    if (!authVerdict.allowed) {
      res.statusCode = authVerdict.statusCode ?? 401;
      for (const [header, value] of Object.entries(authVerdict.headers ?? {})) {
        res.setHeader(header, value);
      }

      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(authVerdict.body ?? { error: "Unauthorized" }));
      return;
    }

    if (options.rateLimiter) {
      const key = readClientKey(req);
      const verdict = await options.rateLimiter.check(key);
      if (!verdict.allowed) {
        res.statusCode = 429;
        if (verdict.retryAfterSeconds) {
          res.setHeader("retry-after", String(verdict.retryAfterSeconds));
        }

        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            error: "Rate limit exceeded",
            retryAfterSeconds: verdict.retryAfterSeconds,
            currentCount: verdict.currentCount,
          }),
        );
        return;
      }
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

function readClientKey(req: http.IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.trim().length > 0) {
    return fwd.split(",")[0]?.trim() ?? "unknown";
  }

  return req.socket.remoteAddress ?? "unknown";
}
