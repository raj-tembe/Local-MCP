import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SecurityEngine } from '../security/security.js';
import { AuditLogger } from '../audit/audit.js';
import { loadConfig } from '../config/config.js';

const DEFAULT_MAX_ROWS = 500;
const DEFAULT_TIMEOUT_MS = 15000;

function expandPath(p: string): string {
  if (p.startsWith('~')) {
    return path.join(os.homedir(), p.slice(1));
  }
  return path.resolve(p);
}

interface DbConnectionConfig {
  driver: 'sqlite' | 'postgres' | 'mysql';
  file?: string;
  env?: string;
  readOnly: boolean;
}

interface SqliteDb {
  prepare: (sql: string) => { all: (...params: any[]) => any[]; run: (...params: any[]) => any };
  pragma: (setting: string) => void;
}

interface PostgresPool {
  query: (sql: string, params?: any[]) => Promise<{ rows: any[]; fields?: any[]; rowCount?: number }>;
  connect: () => Promise<{ query: (sql: string, params?: any[]) => Promise<any>; release: () => void }>;
  end: () => Promise<void>;
}

interface MySqlPool {
  query: (sql: string, params?: any[]) => Promise<[any[], any]>;
  getConnection: () => Promise<{ query: (sql: string, params?: any[]) => Promise<any>; release: () => void }>;
  end: () => Promise<void>;
}

let sqliteDb: SqliteDb | null = null;
let sqlitePath: string | null = null;

function getConnectionConfig(connectionName: string): DbConnectionConfig {
  const config = loadConfig();
  const conn = config.db?.connections?.[connectionName];
  if (!conn) {
    throw new Error(`Database connection "${connectionName}" not configured`);
  }
  return conn as DbConnectionConfig;
}

async function getSqliteDb(config: DbConnectionConfig): Promise<SqliteDb> {
  if (sqliteDb && sqlitePath === config.file) return sqliteDb;
  
  if (!config.file) {
    throw new Error('SQLite connection requires "file" property');
  }
  
  const filePath = expandPath(config.file);
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });
  
  try {
    // @ts-ignore - optional dependency
    const { default: Database } = await import('better-sqlite3') as { default: new (path: string, options?: { readonly?: boolean }) => SqliteDb };
    sqliteDb = new Database(filePath, { readonly: config.readOnly });
    sqlitePath = config.file;
    
    if (config.readOnly) {
      sqliteDb.pragma('query_only = true');
    }
    
    return sqliteDb;
  } catch (e) {
    if (e instanceof Error && e.message.includes("Cannot find module 'better-sqlite3'")) {
      throw new Error('UNAVAILABLE: better-sqlite3 not installed. Add it as a dependency to use SQLite.');
    }
    throw e;
  }
}

async function getPostgresPool(config: DbConnectionConfig): Promise<PostgresPool> {
  if (!config.env) {
    throw new Error('Postgres connection requires "env" property with connection string');
  }
  
  const connectionString = process.env[config.env];
  if (!connectionString) {
    throw new Error(`Environment variable ${config.env} not set`);
  }
  
  try {
    // @ts-ignore - optional dependency
    const pg = await import('pg') as { default: new (config: { connectionString: string; max: number }) => PostgresPool };
    const pool = new pg.default({ 
      connectionString,
      max: 1
    });
    
    return pool;
  } catch (e) {
    if (e instanceof Error && e.message.includes("Cannot find module 'pg'")) {
      throw new Error('UNAVAILABLE: pg not installed. Add it as a dependency to use PostgreSQL.');
    }
    throw e;
  }
}

async function getMySqlPool(config: DbConnectionConfig): Promise<MySqlPool> {
  if (!config.env) {
    throw new Error('MySQL connection requires "env" property with connection string');
  }
  
  const connectionString = process.env[config.env];
  if (!connectionString) {
    throw new Error(`Environment variable ${config.env} not set`);
  }
  
  try {
    // @ts-ignore - optional dependency
    const mysql = await import('mysql2/promise') as { default: { createPool: (config: { uri: string; connectionLimit: number }) => MySqlPool } };
    const pool = mysql.default.createPool({
      uri: connectionString,
      connectionLimit: 1
    });
    
    return pool;
  } catch (e) {
    if (e instanceof Error && e.message.includes("Cannot find module 'mysql2'")) {
      throw new Error('UNAVAILABLE: mysql2 not installed. Add it as a dependency to use MySQL.');
    }
    throw e;
  }
}

async function getConnection(connectionName: string): Promise<{ db: any; config: DbConnectionConfig; close: () => Promise<void> }> {
  const config = getConnectionConfig(connectionName);
  
  if (config.driver === 'sqlite') {
    const db = await getSqliteDb(config);
    return {
      db,
      config,
      close: async () => {}
    };
  } else if (config.driver === 'postgres') {
    const pool = await getPostgresPool(config);
    return {
      db: pool,
      config,
      close: async () => { await pool.end(); }
    };
  } else if (config.driver === 'mysql') {
    const pool = await getMySqlPool(config);
    return {
      db: pool,
      config,
      close: async () => { await pool.end(); }
    };
  }
  
  throw new Error(`Unknown driver: ${config.driver}`);
}

export interface DbTablesResult {
  tables: Array<{ schema: string; name: string; type: 'table' | 'view' }>;
  [key: string]: unknown;
}

export interface DbQueryResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  durationMs: number;
  [key: string]: unknown;
}

export async function runDbTables(
  config: { connection: string },
  security: SecurityEngine,
  audit: AuditLogger,
  sessionId: string
): Promise<DbTablesResult> {
  const decision = await security.authorize('db.tables', { connection: config.connection });
  if (!decision.allowed) {
    throw new Error(decision.reason ?? 'Permission denied');
  }

  const { db, config: connConfig, close } = await getConnection(config.connection);
  
  try {
    let tables: Array<{ schema: string; name: string; type: 'table' | 'view' }> = [];
    
    if (connConfig.driver === 'sqlite') {
      const rows = db.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string; type: string }>;
      tables = rows.map(r => ({ schema: 'main', name: r.name, type: r.type as 'table' | 'view' }));
    } else if (connConfig.driver === 'postgres') {
      const result = await db.query("SELECT table_schema, table_name, table_type FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema')");
      tables = result.rows.map((r: any) => ({ schema: r.table_schema, name: r.table_name, type: r.table_type === 'VIEW' ? 'view' : 'table' }));
    } else if (connConfig.driver === 'mysql') {
      const [rows] = await db.query("SELECT table_schema, table_name, table_type FROM information_schema.tables WHERE table_schema NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')");
      tables = (rows as any[]).map(r => ({ schema: r.TABLE_SCHEMA, name: r.TABLE_NAME, type: r.TABLE_TYPE === 'VIEW' ? 'view' : 'table' }));
    }
    
    await close();

    const argsHash = createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16);
    audit.log({
      timestamp: new Date().toISOString(),
      sessionId,
      tool: 'db.tables',
      decision: 'allow',
      result: `connection=${config.connection} tables=${tables.length} argsHash=${argsHash}`
    });

    return { tables };
  } catch (e) {
    await close();
    throw e;
  }
}

export async function runDbQuery(
  config: {
    connection: string;
    sql: string;
    params?: unknown[];
    maxRows?: number;
    timeoutMs?: number;
    readOnly?: boolean;
  },
  security: SecurityEngine,
  audit: AuditLogger,
  sessionId: string
): Promise<DbQueryResult> {
  const readOnly = config.readOnly ?? true;
  
  const decision = await security.authorize('db.query', { connection: config.connection, sql: config.sql.substring(0, 200), readOnly });
  if (!decision.allowed) {
    throw new Error(decision.reason ?? 'Permission denied');
  }

  const { db, config: connConfig, close } = await getConnection(config.connection);
  const startTime = Date.now();
  
  try {
    // For write operations on read-only connections, reject
    if (readOnly && connConfig.readOnly) {
      const writeKeywords = ['INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'TRUNCATE', 'REPLACE'];
      const upperSql = config.sql.trim().toUpperCase();
      if (writeKeywords.some(kw => upperSql.startsWith(kw))) {
        throw new Error('Read-only connection: write operations not allowed');
      }
    }

    const maxRows = Math.min(config.maxRows ?? DEFAULT_MAX_ROWS, 5000);
    const timeoutMs = Math.min(config.timeoutMs ?? DEFAULT_TIMEOUT_MS, 60000);
    
    let columns: string[] = [];
    let rows: unknown[][] = [];
    let rowCount = 0;
    let truncated = false;

    if (connConfig.driver === 'sqlite') {
      const stmt = db.prepare(config.sql);
      const allRows = config.params ? stmt.all(...config.params) : stmt.all();
      columns = allRows.length > 0 ? Object.keys(allRows[0]) : [];
      rows = allRows.slice(0, maxRows + 1).map((r: any) => Object.values(r));
      rowCount = allRows.length;
      truncated = allRows.length > maxRows;
    } else if (connConfig.driver === 'postgres') {
      const client = await db.connect();
      try {
        await client.query('SET STATEMENT_TIMEOUT = $1', [timeoutMs]);
        if (readOnly && connConfig.readOnly) {
          await client.query('SET TRANSACTION READ ONLY');
        }
        const result = config.params ? await client.query(config.sql, config.params) : await client.query(config.sql);
        columns = result.fields ? result.fields.map((f: any) => f.name) : [];
        rows = result.rows.slice(0, maxRows + 1).map((r: any) => columns.map(c => r[c]));
        rowCount = result.rowCount ?? result.rows.length;
        truncated = result.rows.length > maxRows;
      } finally {
        client.release();
      }
    } else if (connConfig.driver === 'mysql') {
      const conn = await db.getConnection();
      try {
        if (readOnly && connConfig.readOnly) {
          await conn.query('SET SESSION TRANSACTION READ ONLY');
        }
        const [result] = config.params ? await conn.query(config.sql, config.params) : await conn.query(config.sql);
        columns = Array.isArray(result) && result.length > 0 ? Object.keys(result[0]) : [];
        rows = (Array.isArray(result) ? result : [result]).slice(0, maxRows + 1).map((r: any) => columns.map(c => r[c]));
        rowCount = Array.isArray(result) ? result.length : 1;
        truncated = Array.isArray(result) && result.length > maxRows;
      } finally {
        conn.release();
      }
    }

    const durationMs = Date.now() - startTime;

    const argsHash = createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16);
    audit.log({
      timestamp: new Date().toISOString(),
      sessionId,
      tool: 'db.query',
      decision: 'allow',
      result: `connection=${config.connection} rows=${rowCount} truncated=${truncated} duration=${durationMs}ms argsHash=${argsHash}`
    });

    return { columns, rows: rows.slice(0, maxRows), rowCount, truncated, durationMs };
  } catch (e) {
    await close();
    throw e;
  }
}