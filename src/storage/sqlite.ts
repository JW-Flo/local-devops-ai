import initSqlJs, { Database } from "sql.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "fs";
import { join, dirname } from "path";
import { config } from "../config.js";

// ── Multi-DB Registry ──
// Each named database gets its own file under config.dbRoot.
// Legacy path for backward compat migration.

const legacyDbPath = join(config.cacheDir, "state", "devops-ai.db");
const wasmLocator = (file: string) => join(process.cwd(), "node_modules/sql.js/dist", file);

type DbEntry = {
  db: Database;
  dirty: boolean;
  filePath: string;
};

const registry = new Map<string, Promise<DbEntry>>();
let flushTimer: NodeJS.Timeout | null = null;

function getDbFilePath(name: string): string {
  return join(config.dbRoot, `${name}.db`);
}

async function initializeDb(name: string): Promise<DbEntry> {
  const SQL = await initSqlJs({ locateFile: wasmLocator });
  const filePath = getDbFilePath(name);
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Migrate legacy gateway DB on first access
  if (name === "gateway" && !existsSync(filePath) && existsSync(legacyDbPath)) {
    console.log(`[sqlite] migrating ${legacyDbPath} → ${filePath}`);
    mkdirSync(dirname(filePath), { recursive: true });
    copyFileSync(legacyDbPath, filePath);
  }

  const data = existsSync(filePath) ? readFileSync(filePath) : undefined;
  const db = new SQL.Database(data);

  // Gateway default schema
  if (name === "gateway") {
    db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        details TEXT NOT NULL,
        tags TEXT,
        source TEXT,
        created_at TEXT NOT NULL
      );
    `);
  }

  const entry: DbEntry = { db, dirty: false, filePath };

  // Start auto-flush timer on first DB init
  if (!flushTimer) {
    flushTimer = setInterval(flushAll, 10_000);
  }

  return entry;
}

function getDbPromise(name: string): Promise<DbEntry> {
  let p = registry.get(name);
  if (!p) {
    p = initializeDb(name);
    registry.set(name, p);
  }
  return p;
}

async function persist(entry: DbEntry) {
  const data = entry.db.export();
  writeFileSync(entry.filePath, Buffer.from(data));
  entry.dirty = false;
}

async function flushAll() {
  for (const p of registry.values()) {
    try {
      const entry = await p;
      if (entry.dirty) {
        await persist(entry);
      }
    } catch {
      // skip failed entries
    }
  }
}

export type WithDbOptions = {
  persist?: boolean;
  db?: string; // database name, default "gateway"
};

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
