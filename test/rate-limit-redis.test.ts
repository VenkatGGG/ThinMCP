import test from "node:test";
import assert from "node:assert/strict";
import { createRedisRateLimiter } from "../src/rate-limit.js";

const redisUrl = process.env.THINMCP_REDIS_URL;

test(
  "Redis rate limiter enforces fixed window",
  { skip: !redisUrl },
  async () => {
    if (!redisUrl) {
      return;
    }

    const limiter = await createRedisRateLimiter({
      redisUrl,
      maxRequests: 2,
      windowSeconds: 5,
      namespace: `thinmcp:test:${Date.now()}`,
    });

    try {
      const key = `client-${Date.now()}`;
      const v1 = await limiter.check(key);
      const v2 = await limiter.check(key);
      const v3 = await limiter.check(key);

      assert.equal(v1.allowed, true);
      assert.equal(v2.allowed, true);
      assert.equal(v3.allowed, false);
      assert.ok((v3.retryAfterSeconds ?? 0) > 0);
    } finally {
      await limiter.close();
    }
  },
);
