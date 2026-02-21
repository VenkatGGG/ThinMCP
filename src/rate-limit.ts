import crypto from "node:crypto";
import { createClient } from "redis";
import { logWarn } from "./logger.js";

export interface RateLimitConfig {
  redisUrl: string;
  maxRequests: number;
  windowSeconds: number;
  namespace?: string;
}

export interface RateLimitVerdict {
  allowed: boolean;
  retryAfterSeconds?: number;
  currentCount?: number;
}

export interface RateLimiter {
  check: (key: string) => Promise<RateLimitVerdict>;
  close: () => Promise<void>;
}

const LUA_SCRIPT = `
local key = KEYS[1]
local windowMs = tonumber(ARGV[1])
local maxRequests = tonumber(ARGV[2])

local current = redis.call('INCR', key)
if current == 1 then
  redis.call('PEXPIRE', key, windowMs)
end

local ttl = redis.call('PTTL', key)
if ttl < 0 then
  ttl = windowMs
end

if current > maxRequests then
  return {0, current, ttl}
end

return {1, current, ttl}
`;

type RedisClient = ReturnType<typeof createClient>;

export async function createRedisRateLimiter(
  config: RateLimitConfig,
): Promise<RateLimiter> {
  const client = createClient({
    url: config.redisUrl,
  });

  await client.connect();

  const limiter = new RedisFixedWindowRateLimiter(client, {
    maxRequests: Math.max(1, config.maxRequests),
    windowSeconds: Math.max(1, config.windowSeconds),
    namespace: config.namespace ?? "thinmcp:ratelimit",
  });

  return limiter;
}

class RedisFixedWindowRateLimiter implements RateLimiter {
  private readonly client: RedisClient;
  private readonly maxRequests: number;
  private readonly windowSeconds: number;
  private readonly namespace: string;

  public constructor(
    client: RedisClient,
    options: {
      maxRequests: number;
      windowSeconds: number;
      namespace: string;
    },
  ) {
    this.client = client;
    this.maxRequests = options.maxRequests;
    this.windowSeconds = options.windowSeconds;
    this.namespace = options.namespace;
  }

  public async check(key: string): Promise<RateLimitVerdict> {
    const redisKey = `${this.namespace}:${hashKey(key)}`;
    const windowMs = this.windowSeconds * 1000;

    try {
      const reply = (await this.client.eval(LUA_SCRIPT, {
        keys: [redisKey],
        arguments: [String(windowMs), String(this.maxRequests)],
      })) as unknown;

      const [allowedRaw, currentRaw, ttlRaw] = parseReply(reply);
      const allowed = allowedRaw === 1;

      if (allowed) {
        return {
          allowed: true,
          currentCount: currentRaw,
        };
      }

      return {
        allowed: false,
        currentCount: currentRaw,
        retryAfterSeconds: Math.max(1, Math.ceil(ttlRaw / 1000)),
      };
    } catch (error: unknown) {
      logWarn("rate_limit.redis_error", {
        message: error instanceof Error ? error.message : String(error),
      });

      // Fail-open if Redis is transiently unavailable.
      return {
        allowed: true,
      };
    }
  }

  public async close(): Promise<void> {
    await this.client.quit().catch(() => undefined);
  }
}

function parseReply(reply: unknown): [number, number, number] {
  if (!Array.isArray(reply) || reply.length < 3) {
    throw new Error("Unexpected Redis rate-limit response");
  }

  const allowedRaw = toInt(reply[0]);
  const currentRaw = toInt(reply[1]);
  const ttlRaw = toInt(reply[2]);
  return [allowedRaw, currentRaw, ttlRaw];
}

function toInt(value: unknown): number {
  if (typeof value === "number") {
    return Math.trunc(value);
  }

  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  throw new Error(`Unexpected numeric value from Redis: ${String(value)}`);
}

function hashKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 24);
}
