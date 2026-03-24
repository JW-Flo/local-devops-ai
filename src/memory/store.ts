import { withDb } from "../storage/sqlite.js";

export type MemoryEntry = {
  id: string;
  title: string;
  details: string;
  tags?: string[];
  source?: string;
  createdAt: string;
};

export class MemoryStore {
  async add(entry: Omit<MemoryEntry, "createdAt" | "id"> & { tags?: string[] }) {
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    await withDb((db) => {
      const stmt = db.prepare(
        "INSERT INTO memories (id, title, details, tags, source, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      );
      stmt.run([
        id,
        entry.title,
        entry.details,
        entry.tags?.join(",") ?? null,
        entry.source ?? null,
        createdAt,
      ]);
      stmt.free();
    }, { persist: true });
    return { id, createdAt };
  }

  async list(limit = 50): Promise<MemoryEntry[]> {
    return withDb((db) => {
      const stmt = db.prepare(
        "SELECT id, title, details, tags, source, created_at as createdAt FROM memories ORDER BY datetime(created_at) DESC LIMIT ?",
      );
      stmt.bind([limit]);
      const results: MemoryEntry[] = [];
      while (stmt.step()) {
        const row = stmt.getAsObject();
        results.push({
          id: row.id as string,
          title: row.title as string,
          details: row.details as string,
          tags: row.tags ? (row.tags as string).split(",").filter(Boolean) : undefined,
          source: (row.source as string) ?? undefined,
          createdAt: row.createdAt as string,
        });
      }
      stmt.free();
      return results;
    });
  }

  /** Search memories by keyword match in title/details and optional tag filter */
  async search(query: string, opts?: { tags?: string[]; limit?: number; source?: string }): Promise<MemoryEntry[]> {
    const limit = opts?.limit ?? 10;
    return withDb((db) => {
      let sql = `SELECT id, title, details, tags, source, created_at as createdAt
        FROM memories WHERE 1=1`;
      const params: any[] = [];

      if (query) {
        // SQLite LIKE-based text search across title and details
        const terms = query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 5);
        for (const term of terms) {
          sql += ` AND (LOWER(title) LIKE ? OR LOWER(details) LIKE ?)`;
          params.push(`%${term}%`, `%${term}%`);
        }
      }

      if (opts?.tags?.length) {
        for (const tag of opts.tags) {
          sql += ` AND LOWER(tags) LIKE ?`;
          params.push(`%${tag.toLowerCase()}%`);
        }
      }

      if (opts?.source) {
        sql += ` AND source = ?`;
        params.push(opts.source);
      }

      sql += ` ORDER BY datetime(created_at) DESC LIMIT ?`;
      params.push(limit);

      const stmt = db.prepare(sql);
      stmt.bind(params);
      const results: MemoryEntry[] = [];
      while (stmt.step()) {
        const row = stmt.getAsObject();
        results.push({
          id: row.id as string,
          title: row.title as string,
          details: row.details as string,
          tags: row.tags ? (row.tags as string).split(",").filter(Boolean) : undefined,
          source: (row.source as string) ?? undefined,
          createdAt: row.createdAt as string,
        });
      }
      stmt.free();
      return results;
    });
  }

  /** Get recent agent run summaries for continuity */
  async getRecentAgentRuns(limit = 5): Promise<MemoryEntry[]> {
    return this.search("", { source: "orchestrator-agent", limit });
  }
}

export const memoryStore = new MemoryStore();
