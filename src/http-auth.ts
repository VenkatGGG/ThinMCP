import crypto from "node:crypto";
import {
  createRemoteJWKSet,
  errors as JoseErrors,
  jwtVerify,
  type JWTPayload,
} from "jose";

export type HttpAuthConfig =
  | { mode: "none" }
  | { mode: "bearer"; token: string }
  | {
      mode: "jwt";
      jwksUrl: string;
      issuer?: string;
      audience?: string;
      algorithms?: string[];
    };

export interface AuthVerdict {
  allowed: boolean;
  statusCode?: number;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  principal?: {
    sub?: string;
    iss?: string;
    aud?: string | string[];
    exp?: number;
    iat?: number;
    scope?: string;
  };
}

interface JwtVerifier {
  verify: (token: string) => Promise<JWTPayload>;
}

export class HttpAuthenticator {
  private readonly config: HttpAuthConfig;
  private readonly jwtVerifier: JwtVerifier | null;

  public constructor(config: HttpAuthConfig) {
    this.config = config;
    this.jwtVerifier = config.mode === "jwt" ? createJwtVerifier(config) : null;
  }

  public get mode(): HttpAuthConfig["mode"] {
    return this.config.mode;
  }

  public async authorize(authHeader: string | undefined): Promise<AuthVerdict> {
    if (this.config.mode === "none") {
      return { allowed: true };
    }

    const token = parseBearerToken(authHeader);
    if (!token) {
      return unauthorized("Missing or invalid bearer token");
    }

    if (this.config.mode === "bearer") {
      if (!safeEqual(token, this.config.token)) {
        return unauthorized("Invalid bearer token");
      }

      return { allowed: true };
    }

    if (!this.jwtVerifier) {
      return unauthorized("JWT verifier not initialized");
    }

    try {
      const payload = await this.jwtVerifier.verify(token);
      return {
        allowed: true,
        principal: {
          sub: readString(payload.sub),
          iss: readString(payload.iss),
          aud: payload.aud as string | string[] | undefined,
          exp: typeof payload.exp === "number" ? payload.exp : undefined,
          iat: typeof payload.iat === "number" ? payload.iat : undefined,
          scope: readString(payload.scope),
        },
      };
    } catch (error: unknown) {
      const message = normalizeJwtError(error);
      return unauthorized(message);
    }
  }
}

function createJwtVerifier(config: Extract<HttpAuthConfig, { mode: "jwt" }>): JwtVerifier {
  const jwks = createRemoteJWKSet(new URL(config.jwksUrl));
  const algorithms =
    config.algorithms && config.algorithms.length > 0
      ? config.algorithms
      : undefined;

  return {
    verify: async (token: string) => {
      const result = await jwtVerify(token, jwks, {
        ...(config.issuer ? { issuer: config.issuer } : {}),
        ...(config.audience ? { audience: config.audience } : {}),
        ...(algorithms ? { algorithms } : {}),
      });

      return result.payload;
    },
  };
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

function unauthorized(message: string): AuthVerdict {
  return {
    allowed: false,
    statusCode: 401,
    headers: {
      "www-authenticate": "Bearer",
    },
    body: {
      error: "Unauthorized",
      message,
    },
  };
}

function normalizeJwtError(error: unknown): string {
  if (error instanceof JoseErrors.JWTExpired) {
    return "JWT token expired";
  }

  if (error instanceof JoseErrors.JWSSignatureVerificationFailed) {
    return "JWT signature verification failed";
  }

  if (error instanceof JoseErrors.JWTClaimValidationFailed) {
    return `JWT claim validation failed: ${error.message}`;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
