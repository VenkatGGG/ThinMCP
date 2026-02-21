import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  type JWTPayload,
} from "jose";
import { HttpAuthenticator } from "../src/http-auth.js";

test("HttpAuthenticator allows when mode is none", async () => {
  const auth = new HttpAuthenticator({ mode: "none" });
  const verdict = await auth.authorize(undefined);
  assert.equal(verdict.allowed, true);
});

test("HttpAuthenticator validates static bearer token", async () => {
  const auth = new HttpAuthenticator({ mode: "bearer", token: "abc123" });

  const ok = await auth.authorize("Bearer abc123");
  assert.equal(ok.allowed, true);

  const bad = await auth.authorize("Bearer wrong");
  assert.equal(bad.allowed, false);
  assert.equal(bad.statusCode, 401);
});

test("HttpAuthenticator validates JWT against JWKS", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.use = "sig";
  jwk.kid = "test-key";

  const { server, jwksUrl } = await startJwksServer({
    keys: [jwk],
  });

  try {
    const token = await signJwt(privateKey, {
      iss: "https://issuer.example",
      aud: "thinmcp-clients",
      sub: "user-123",
      scope: "read write",
    });

    const auth = new HttpAuthenticator({
      mode: "jwt",
      jwksUrl,
      issuer: "https://issuer.example",
      audience: "thinmcp-clients",
    });

    const verdict = await auth.authorize(`Bearer ${token}`);
    assert.equal(verdict.allowed, true);
    assert.equal(verdict.principal?.sub, "user-123");

    const wrongAudToken = await signJwt(privateKey, {
      iss: "https://issuer.example",
      aud: "wrong-audience",
      sub: "user-123",
    });
    const wrongAudVerdict = await auth.authorize(`Bearer ${wrongAudToken}`);
    assert.equal(wrongAudVerdict.allowed, false);
    assert.equal(wrongAudVerdict.statusCode, 401);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }
});

async function signJwt(
  privateKey: CryptoKey,
  payload: JWTPayload,
): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000);

  return new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + 60)
    .sign(privateKey);
}

async function startJwksServer(body: Record<string, unknown>): Promise<{
  server: http.Server;
  jwksUrl: string;
}> {
  const server = http.createServer((_, res) => {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to obtain local server address");
  }

  return {
    server,
    jwksUrl: `http://127.0.0.1:${address.port}/.well-known/jwks.json`,
  };
}
