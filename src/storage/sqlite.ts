import initSqlJs, { Database } from "sql.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "fs";
import { join, dirname } from "path";
import { config } from "../config.js";

// ── Multi-DB Registry ──
// Each named database gets its own file under config.dbRoot (D:/ai-knowledge/databases/)
// Default "gateway" DB inherits all tables from the old devops-ai.db

type DbEntry = {
  db: Database;
  path: string;
  dirty: boolean;
};

const wasmLocator = (file: string) =>
  join(process.cwd(), "node_modules/sql.js/dist", file);

let SQL: Awaited<ReturnType<typeof initSqlJs>> | null = null;
const dbRegistry = new Map<string, Promise<DbEntry>>();

async function getSqlJs() {
  if (!SQL) {
    SQL = await initSqlJs({ locateFile: wasmLocator });
  }
  return SQL;
}

// Legacy DB path for migration
const legacyDbPath = join(config.cacheDir, "state", "devops-ai.db");

function dbPath(name: string): string {
  return join(config.dbRoot, `${name}.db`);
}

async function openDb(name: string): Promise<DbEntry> {
  const sqljs = await getSqlJs();
  const dir = config.dbRoot;
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const filePath = dbPath(name);

  // Migration: if opening "gateway" and it doesn't exist but legacy does, copy it
  if (name === "gateway" && !existsSync(filePath) && existsSync(legacyDbPath)) {
    console.log(`[sqlite] migrating ${legacyDbPath} → ${filePath}`);
    mkdirSync(dirname(filePath), { recursive: true });
    copyFileSync(legacyDbPath, filePath);
  }

  const data = existsSync(filePath) ? readFileSync(filePath) : undefined;
  const db = new sqljs.Database(data);

  // Enable WAL mode for better concurrent read perf
  db.exec("PRAGMA journal_mode=WAL;");

  return { db, path: filePath, dirty: false };
}

function getDbPromise(name: string): Promise<DbEntry> {
  let promise = dbRegistry.get(name);
  if (!promise) {
    promise = openDb(name);
    dbRegistry.set(name, promise);
  }
  return promise;
}

// ── Persist (flush to disk) ──

async function persist(entry: DbEntry): Promise<void> {
  const data = entry.db.export();
  const dir = dirname(entry.path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(entry.path, Buffer.from(data));
  entry.dirty = false;
}

// ── Auto-flush timer (every 10s for dirty DBs) ──

setInterval(async () => {
  for (const [name, promise] of dbRegistry) {
    try {
      const entry = await promise;
      if (entry.dirty) {
        await persist(entry);
      }
    } catch {
      // DB not ready yet or failed — skip
    }
  }
}, 10_000);

// ── Public API ──

export type WithDbOptions = {
  persist?: boolean;
  db?: string; // database name, default "gateway"
};

/**
 * Execute a function against a named SQLite database.
 * Default DB is "gateway" (migrated from old devops-ai.db).
 * Use db: "market-agent" for weather arbitrage data, etc.
 */
export async function withDb<T>(
  fn: (db: Database) => T | Promise<T>,
  options?: WithDbOptions | { persist?: boolean },
): Promise<T> {
  const dbName = (options as WithDbOptions)?.db ?? "gateway";
  const entry = await getDbPromise(dbName);
  const result = await fn(entry.db);
  if (options?.persist) {
    entry.dirty = true;
    await persist(entry);
  }
  return result;
}

/**
 * Get the file path for a named database.
 * Useful for diagnostics / dashboard display.
 */
export function getDbPath(name = "gateway"): string {
  return dbPath(name);
}

/**
 * List all registered database names.
 */
export function listDatabases(): string[] {
  return Array.from(dbRegistry.keys());
}

// ── Bootstrap default "gateway" DB with core tables ──

// Eagerly initialize gateway DB and ensure memories table exists
const gatewayInit = getDbPromise("gateway").then(async (entry) => {
  entry.db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      details TEXT NOT NULL,
      tags TEXT,
      source TEXT,
      created_at TEXT NOT NULL
    );
  `);
  await persist(entry);
  console.log(`[sqlite] gateway DB ready at ${entry.path}`);
  return entry;
});

// Re-export the gateway init promise for startup sequencing
export const gatewayReady = gatewayInit;
