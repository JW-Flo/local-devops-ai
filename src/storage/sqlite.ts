import initSqlJs, { Database } from "sql.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { config } from "../config.js";

const dbPath = join(config.cacheDir, "state", "devops-ai.db");
const wasmLocator = (file: string) => join(process.cwd(), "node_modules/sql.js/dist", file);

async function initializeDb(): Promise<Database> {
  const SQL = await initSqlJs({ locateFile: wasmLocator });
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const data = existsSync(dbPath) ? readFileSync(dbPath) : undefined;
  const db = new SQL.Database(data);
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
  return db;
}

const dbPromise = initializeDb();

async function persist(db: Database) {
  const data = db.export();
  writeFileSync(dbPath, Buffer.from(data));
}

export async function withDb<T>(fn: (db: Database) => T | Promise<T>, options?: { persist?: boolean }): Promise<T> {
  const db = await dbPromise;
  const result = await fn(db);
  if (options?.persist) {
    await persist(db);
  }
  return result;
}
