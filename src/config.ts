import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { z } from "zod";
import type {
  ResolvedConfig,
  SourceServerConfig,
  ThinMcpConfig,
} from "./types.js";

const authSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({ type: z.literal("bearer_env"), env: z.string().min(1) }),
]);

const probeSchema = z.object({
  toolName: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).optional(),
});

const serverBaseSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  enabled: z.boolean().optional().default(true),
  allowTools: z.array(z.string().min(1)).optional().default(["*"]),
  probe: probeSchema.optional(),
});

const httpServerSchema = serverBaseSchema.extend({
  transport: z.literal("http").default("http"),
  url: z.string().url(),
  auth: authSchema.optional().default({ type: "none" }),
});

const stdioServerSchema = serverBaseSchema.extend({
  transport: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).optional().default([]),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
  stderr: z.enum(["inherit", "pipe"]).optional().default("inherit"),
});

const serverSchema = z.discriminatedUnion("transport", [
  httpServerSchema,
  stdioServerSchema,
]);

const configSchema = z.object({
  servers: z.array(serverSchema).min(1),
  sync: z
    .object({
      intervalSeconds: z.number().int().positive().default(300),
      onStart: z.boolean().default(true),
    })
    .optional(),
  runtime: z
    .object({
      codeTimeoutMs: z.number().int().positive().default(15_000),
      maxCodeLength: z.number().int().positive().default(20_000),
      maxResultChars: z.number().int().positive().default(60_000),
    })
    .optional(),
  catalog: z
    .object({
      dbPath: z.string().min(1).default("./data/thinmcp.db"),
      snapshotDir: z.string().min(1).default("./snapshots"),
    })
    .optional(),
});

function resolvePath(fromFile: string, target: string): string {
  if (path.isAbsolute(target)) {
    return target;
  }

  return path.resolve(path.dirname(fromFile), target);
}

function resolveServerPaths(
  selectedPath: string,
  servers: SourceServerConfig[],
): SourceServerConfig[] {
  return servers.map((server) => {
    if (server.transport !== "stdio" || !server.cwd) {
      return server;
    }

    return {
      ...server,
      cwd: resolvePath(selectedPath, server.cwd),
    };
  });
}

export function loadConfig(configPath?: string): ResolvedConfig {
  const selectedPath =
    configPath ??
    process.env.THINMCP_CONFIG ??
    path.resolve(process.cwd(), "config/mcp-sources.yaml");

  if (!fs.existsSync(selectedPath)) {
    throw new Error(`Config file not found: ${selectedPath}`);
  }

  const raw = fs.readFileSync(selectedPath, "utf8");
  const parsedDoc = (yaml.load(raw) ?? {}) as ThinMcpConfig;
  const parsed = configSchema.parse(parsedDoc);

  const catalog = {
    dbPath: resolvePath(selectedPath, parsed.catalog?.dbPath ?? "./data/thinmcp.db"),
    snapshotDir: resolvePath(selectedPath, parsed.catalog?.snapshotDir ?? "./snapshots"),
  };

  return {
    configPath: selectedPath,
    servers: resolveServerPaths(selectedPath, parsed.servers),
    sync: {
      intervalSeconds: parsed.sync?.intervalSeconds ?? 300,
      onStart: parsed.sync?.onStart ?? true,
    },
    runtime: {
      codeTimeoutMs: parsed.runtime?.codeTimeoutMs ?? 15_000,
      maxCodeLength: parsed.runtime?.maxCodeLength ?? 20_000,
      maxResultChars: parsed.runtime?.maxResultChars ?? 60_000,
    },
    catalog,
  };
}
