export type AuthConfig =
  | { type: "none" }
  | { type: "bearer_env"; env: string };

export interface ServerProbeConfig {
  toolName: string;
  arguments?: Record<string, unknown>;
}

export interface SourceServerBaseConfig {
  id: string;
  name?: string;
  enabled?: boolean;
  allowTools?: string[];
  probe?: ServerProbeConfig;
}

export interface HttpSourceServerConfig extends SourceServerBaseConfig {
  transport: "http";
  url: string;
  auth?: AuthConfig;
}

export interface StdioSourceServerConfig extends SourceServerBaseConfig {
  transport: "stdio";
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stderr?: "inherit" | "pipe";
}

export type SourceServerConfig = HttpSourceServerConfig | StdioSourceServerConfig;

export interface ThinMcpConfig {
  servers: SourceServerConfig[];
  sync?: {
    intervalSeconds?: number;
    onStart?: boolean;
  };
  runtime?: {
    codeTimeoutMs?: number;
    maxCodeLength?: number;
    maxResultChars?: number;
  };
  catalog?: {
    dbPath?: string;
    snapshotDir?: string;
  };
}

export interface RuntimeSettings {
  codeTimeoutMs: number;
  maxCodeLength: number;
  maxResultChars: number;
}

export interface CatalogSettings {
  dbPath: string;
  snapshotDir: string;
}

export interface SyncSettings {
  intervalSeconds: number;
  onStart: boolean;
}

export interface ResolvedConfig {
  configPath: string;
  servers: SourceServerConfig[];
  runtime: RuntimeSettings;
  catalog: CatalogSettings;
  sync: SyncSettings;
}

export interface NormalizedToolRecord {
  serverId: string;
  serverName: string;
  serverUrl: string;
  toolName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown> | null;
  annotations: Record<string, unknown> | null;
  title: string | null;
  searchableText: string;
  snapshotHash: string;
}

export interface SearchQuery {
  query?: string;
  serverId?: string;
  limit?: number;
}

export interface ExecuteToolInput {
  serverId: string;
  name: string;
  arguments?: Record<string, unknown>;
}
