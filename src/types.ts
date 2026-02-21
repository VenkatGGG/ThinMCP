export type AuthConfig =
  | { type: "none" }
  | { type: "bearer_env"; env: string };

export interface SourceServerConfig {
  id: string;
  name?: string;
  transport: "http";
  url: string;
  enabled?: boolean;
  auth?: AuthConfig;
  allowTools?: string[];
}

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
