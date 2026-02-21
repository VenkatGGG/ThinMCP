import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { NormalizedToolRecord, SearchQuery, SourceServerConfig } from "./types.js";

export interface ServerRecord {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  allowTools: string[];
  lastSyncedAt: string | null;
}

export interface ToolRecord {
  serverId: string;
  serverName: string;
  serverUrl: string;
  toolName: string;
  title: string | null;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown> | null;
  annotations: Record<string, unknown> | null;
  snapshotHash: string;
}

export class CatalogStore {
  private readonly db: Database.Database;

  public constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.initSchema();
  }

  public close(): void {
    this.db.close();
  }

  public upsertServers(servers: SourceServerConfig[]): void {
    const statement = this.db.prepare(`
      INSERT INTO servers (id, name, url, enabled, allow_tools_json)
      VALUES (@id, @name, @url, @enabled, @allowTools)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        url = excluded.url,
        enabled = excluded.enabled,
        allow_tools_json = excluded.allow_tools_json
    `);

    const run = this.db.transaction((rows: SourceServerConfig[]) => {
      for (const server of rows) {
        statement.run({
          id: server.id,
          name: server.name ?? server.id,
          url: server.url,
          enabled: server.enabled === false ? 0 : 1,
          allowTools: JSON.stringify(server.allowTools ?? ["*"]),
        });
      }
    });

    run(servers);
  }

  public replaceServerTools(
    serverId: string,
    snapshotHash: string,
    snapshotPath: string,
    tools: NormalizedToolRecord[],
  ): void {
    const deleteToolsStatement = this.db.prepare(
      "DELETE FROM tools WHERE server_id = ?",
    );
    const insertToolStatement = this.db.prepare(`
      INSERT INTO tools (
        server_id,
        server_name,
        server_url,
        tool_name,
        title,
        description,
        input_schema_json,
        output_schema_json,
        annotations_json,
        searchable_text,
        snapshot_hash
      )
      VALUES (
        @serverId,
        @serverName,
        @serverUrl,
        @toolName,
        @title,
        @description,
        @inputSchema,
        @outputSchema,
        @annotations,
        @searchable,
        @snapshotHash
      )
    `);
    const insertSnapshotStatement = this.db.prepare(`
      INSERT OR IGNORE INTO snapshots (
        server_id,
        snapshot_hash,
        snapshot_path
      )
      VALUES (?, ?, ?)
    `);
    const markSyncedStatement = this.db.prepare(`
      UPDATE servers
      SET last_synced_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);

    const run = this.db.transaction(() => {
      deleteToolsStatement.run(serverId);

      for (const tool of tools) {
        insertToolStatement.run({
          serverId: tool.serverId,
          serverName: tool.serverName,
          serverUrl: tool.serverUrl,
          toolName: tool.toolName,
          title: tool.title,
          description: tool.description,
          inputSchema: JSON.stringify(tool.inputSchema ?? {}),
          outputSchema: tool.outputSchema ? JSON.stringify(tool.outputSchema) : null,
          annotations: tool.annotations ? JSON.stringify(tool.annotations) : null,
          searchable: tool.searchableText,
          snapshotHash,
        });
      }

      insertSnapshotStatement.run(serverId, snapshotHash, snapshotPath);
      markSyncedStatement.run(serverId);
    });

    run();
  }

  public listServers(): ServerRecord[] {
    const statement = this.db.prepare(`
      SELECT id, name, url, enabled, allow_tools_json, last_synced_at
      FROM servers
      ORDER BY id ASC
    `);

    const rows = statement.all() as Record<string, unknown>[];
    return rows.map((row) => ({
        id: String(row.id),
        name: String(row.name),
        url: String(row.url),
        enabled: Number(row.enabled) === 1,
        allowTools: parseJsonArray(row.allow_tools_json),
        lastSyncedAt: row.last_synced_at ? String(row.last_synced_at) : null,
      }));
  }

  public searchTools(query: SearchQuery): ToolRecord[] {
    const safeLimit = clampLimit(query.limit);

    if (!query.query || query.query.trim().length === 0) {
      const statement = this.db.prepare(`
        SELECT
          server_id,
          server_name,
          server_url,
          tool_name,
          title,
          description,
          input_schema_json,
          output_schema_json,
          annotations_json,
          snapshot_hash
        FROM tools
        WHERE (?1 IS NULL OR server_id = ?1)
        ORDER BY server_id ASC, tool_name ASC
        LIMIT ?2
      `);

      const rows = statement.all(query.serverId ?? null, safeLimit) as Record<
        string,
        unknown
      >[];
      return rows.map((row) => mapToolRecord(row));
    }

    const normalizedQuery = `%${query.query.toLowerCase()}%`;
    const statement = this.db.prepare(`
      SELECT
        server_id,
        server_name,
        server_url,
        tool_name,
        title,
        description,
        input_schema_json,
        output_schema_json,
        annotations_json,
        snapshot_hash
      FROM tools
      WHERE (?1 IS NULL OR server_id = ?1)
        AND searchable_text LIKE ?2
      ORDER BY server_id ASC, tool_name ASC
      LIMIT ?3
    `);

    const rows = statement.all(
      query.serverId ?? null,
      normalizedQuery,
      safeLimit,
    ) as Record<string, unknown>[];
    return rows.map((row) => mapToolRecord(row));
  }

  public getTool(serverId: string, toolName: string): ToolRecord | null {
    const statement = this.db.prepare(`
      SELECT
        server_id,
        server_name,
        server_url,
        tool_name,
        title,
        description,
        input_schema_json,
        output_schema_json,
        annotations_json,
        snapshot_hash
      FROM tools
      WHERE server_id = ? AND tool_name = ?
      LIMIT 1
    `);

    const row = statement.get(serverId, toolName);
    if (!row) {
      return null;
    }

    return mapToolRecord(row as Record<string, unknown>);
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        allow_tools_json TEXT NOT NULL,
        last_synced_at TEXT
      );

      CREATE TABLE IF NOT EXISTS tools (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        server_id TEXT NOT NULL,
        server_name TEXT NOT NULL,
        server_url TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        title TEXT,
        description TEXT NOT NULL,
        input_schema_json TEXT NOT NULL,
        output_schema_json TEXT,
        annotations_json TEXT,
        searchable_text TEXT NOT NULL,
        snapshot_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(server_id, tool_name)
      );

      CREATE INDEX IF NOT EXISTS idx_tools_server_id ON tools(server_id);
      CREATE INDEX IF NOT EXISTS idx_tools_searchable ON tools(searchable_text);

      CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        server_id TEXT NOT NULL,
        snapshot_hash TEXT NOT NULL,
        snapshot_path TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(server_id, snapshot_hash)
      );
    `);
  }
}

function clampLimit(value: number | undefined): number {
  if (!value || Number.isNaN(value)) {
    return 30;
  }

  return Math.max(1, Math.min(100, value));
}

function parseJsonArray(value: unknown): string[] {
  if (typeof value !== "string") {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return [];
  }
}

function parseJsonObject(
  value: unknown,
): Record<string, unknown> | null {
  if (typeof value !== "string") {
    return null;
  }

  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }

    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function mapToolRecord(row: Record<string, unknown>): ToolRecord {
  return {
    serverId: String(row.server_id),
    serverName: String(row.server_name),
    serverUrl: String(row.server_url),
    toolName: String(row.tool_name),
    title: row.title ? String(row.title) : null,
    description: String(row.description),
    inputSchema: parseJsonObject(row.input_schema_json) ?? {},
    outputSchema: parseJsonObject(row.output_schema_json),
    annotations: parseJsonObject(row.annotations_json),
    snapshotHash: String(row.snapshot_hash),
  };
}
