import http from "node:http";
import crypto from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface HttpTransportConfig {
  host: string;
  port: number;
  authToken?: string;
  rateLimit?: {
    maxRequests: number;
    windowSeconds: number;
  };
}

export interface RunningHttpTransport {
  endpointUrl: string;
  close: () => Promise<void>;
}

export async function startHttpTransport(
  server: McpServer,
  config: HttpTransportConfig,
): Promise<RunningHttpTransport> {
  const rateLimiter =
    config.rateLimit && config.rateLimit.maxRequests > 0
      ? new FixedWindowRateLimiter(
          config.rateLimit.maxRequests,
          config.rateLimit.windowSeconds,
        )
      : null;

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  await server.connect(transport);

  const nodeServer = http.createServer((req, res) => {
    void handleRequest(transport, req, res, {
      authToken: config.authToken,
      rateLimiter,
    });
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
  options: {
    authToken?: string;
    rateLimiter: FixedWindowRateLimiter | null;
  },
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

    if (options.authToken) {
      const authHeader = req.headers.authorization;
      const provided = parseBearerToken(authHeader);
      if (!provided || !safeEqual(provided, options.authToken)) {
        res.statusCode = 401;
        res.setHeader("www-authenticate", "Bearer");
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
    }

    if (options.rateLimiter) {
      const key = readClientKey(req);
      const verdict = options.rateLimiter.check(key);
      if (!verdict.allowed) {
        res.statusCode = 429;
        res.setHeader("retry-after", String(verdict.retryAfterSeconds));
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            error: "Rate limit exceeded",
            retryAfterSeconds: verdict.retryAfterSeconds,
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

function parseBearerToken(header: string | undefined): string | null {
  if (!header) {
    return null;
  }

  const trimmed = header.trim();
  if (!trimmed.toLowerCase().startsWith("bearer ")) {
    return null;
  }

  const token = trimmed.slice(7).trim();
  return token.length > 0 ? token : null;
}

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(aBuf, bBuf);
}

function readClientKey(req: http.IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.trim().length > 0) {
    return fwd.split(",")[0]?.trim() ?? "unknown";
  }

  return req.socket.remoteAddress ?? "unknown";
}

class FixedWindowRateLimiter {
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly buckets: Map<string, { count: number; startedAt: number }>;

  public constructor(maxRequests: number, windowSeconds: number) {
    this.maxRequests = Math.max(1, maxRequests);
    this.windowMs = Math.max(1, windowSeconds) * 1000;
    this.buckets = new Map();
  }

  public check(key: string): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
    const now = Date.now();
    const existing = this.buckets.get(key);
    if (!existing || now - existing.startedAt >= this.windowMs) {
      this.buckets.set(key, { count: 1, startedAt: now });
      this.gc(now);
      return { allowed: true };
    }

    existing.count += 1;
    if (existing.count <= this.maxRequests) {
      return { allowed: true };
    }

    const retryAfterMs = Math.max(1, existing.startedAt + this.windowMs - now);
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
    };
  }

  private gc(now: number): void {
    for (const [key, bucket] of this.buckets.entries()) {
      if (now - bucket.startedAt >= this.windowMs) {
        this.buckets.delete(key);
      }
    }
  }
}
