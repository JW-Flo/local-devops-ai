import { withDb } from "../storage/sqlite.js";
import { config } from "../config.js";

export type MemoryEntry = {
  id: string;
  title: string;
  details: string;
  tags?: string[];
  source?: string;
  createdAt: string;
  /** Semantic similarity score (only present in vector search results) */
  score?: number;
};

const MEMORY_COLLECTION = "devops_ai_memories";

// ── Qdrant Vector Backend ──

let qdrantReady = false;

async function ensureMemoryCollection(): Promise<void> {
  try {
    const check = await fetch(`${config.qdrantUrl}/collections/${MEMORY_COLLECTION}`);
    if (check.ok) { qdrantReady = true; return; }

    await fetch(`${config.qdrantUrl}/collections/${MEMORY_COLLECTION}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vectors: { size: config.embedDimensions, distance: "Cosine" },
      }),
    });
    qdrantReady = true;
    console.log("[memory-store] created Qdrant collection for memories");
  } catch (err) {
    console.warn("[memory-store] Qdrant not available for vector search:", (err as Error).message);
    qdrantReady = false;
  }
}

async function embed(text: string): Promise<number[]> {
  const res = await fetch(`${config.ollamaHost}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: config.embedModel, prompt: text }),
  });
  if (!res.ok) throw new Error(`Embedding error: ${res.statusText}`);
  const data = (await res.json()) as { embedding: number[] };
  return data.embedding;
}

function stringToUUID(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash = hash & hash;
  }
  let hash2 = 5381;
  for (let i = 0; i < str.length; i++) {
    hash2 = ((hash2 << 5) + hash2) + str.charCodeAt(i);
    hash2 = hash2 & hash2;
  }
  const hex = Math.abs(hash).toString(16).padStart(8, "0");
  const hex2 = Math.abs(hash2).toString(16).padStart(8, "0");
  return `${hex.slice(0, 8)}-${hex.slice(0, 4)}-4${hex.slice(1, 4)}-8${hex2.slice(0, 3)}-${hex2.padEnd(12, "0").slice(0, 12)}`;
}

async function upsertToQdrant(id: string, title: string, details: string, tags?: string[], source?: string): Promise<void> {
  if (!qdrantReady) return;
  try {
    const text = `${title}\n${details}`;
    const vector = await embed(text.slice(0, 1000));
    await fetch(`${config.qdrantUrl}/collections/${MEMORY_COLLECTION}/points?wait=true`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        points: [{
          id: stringToUUID(id),
          vector,
          payload: {
            memoryId: id,
            title,
            details: details.slice(0, 2000),
            tags: tags?.join(",") ?? "",
            source: source ?? "",
            createdAt: new Date().toISOString(),
          },
        }],
      }),
    });
  } catch {
    // Best effort — don't let vector indexing break the write path
  }
}

// ── Memory Store Class ──

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

    // Async vector index — fire and forget
    upsertToQdrant(id, entry.title, entry.details, entry.tags, entry.source).catch(() => {});

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

  /** Text search — SQLite LIKE-based (fast, keyword match) */
  async search(query: string, opts?: { tags?: string[]; limit?: number; source?: string }): Promise<MemoryEntry[]> {
    const limit = opts?.limit ?? 10;
    return withDb((db) => {
      let sql = `SELECT id, title, details, tags, source, created_at as createdAt
        FROM memories WHERE 1=1`;
      const params: any[] = [];

      if (query) {
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

  /**
   * Semantic search — Qdrant vector similarity.
   * Falls back to text search if Qdrant is unavailable.
   */
  async semanticSearch(query: string, opts?: { limit?: number; source?: string }): Promise<MemoryEntry[]> {
    const limit = opts?.limit ?? 10;

    if (!qdrantReady) {
      console.log("[memory-store] Qdrant unavailable, falling back to text search");
      return this.search(query, { limit, source: opts?.source });
    }

    try {
      const vector = await embed(query);

      const filter: any = {};
      if (opts?.source) {
        filter.must = [{ key: "source", match: { value: opts.source } }];
      }

      const res = await fetch(`${config.qdrantUrl}/collections/${MEMORY_COLLECTION}/points/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vector,
          limit,
          with_payload: true,
          filter: Object.keys(filter).length ? filter : undefined,
        }),
      });

      if (!res.ok) {
        console.warn(`[memory-store] Qdrant search failed: ${res.status}`);
        return this.search(query, { limit, source: opts?.source });
      }

      const data = (await res.json()) as {
        result: Array<{ payload: Record<string, any>; score: number }>;
      };

      return (data.result ?? []).map((r) => ({
        id: r.payload.memoryId as string,
        title: r.payload.title as string,
        details: r.payload.details as string,
        tags: r.payload.tags ? (r.payload.tags as string).split(",").filter(Boolean) : undefined,
        source: (r.payload.source as string) || undefined,
        createdAt: r.payload.createdAt as string,
        score: r.score,
      }));
    } catch (err) {
      console.warn(`[memory-store] semantic search failed: ${(err as Error).message}`);
      return this.search(query, { limit, source: opts?.source });
    }
  }

  /** Get recent agent run summaries for continuity */
  async getRecentAgentRuns(limit = 5): Promise<MemoryEntry[]> {
    return this.search("", { source: "orchestrator-agent", limit });
  }

  /** Get Qdrant stats for the memory collection */
  async vectorStats(): Promise<{ points: number; qdrantReady: boolean }> {
    if (!qdrantReady) return { points: 0, qdrantReady: false };
    try {
      const res = await fetch(`${config.qdrantUrl}/collections/${MEMORY_COLLECTION}`);
      if (!res.ok) return { points: 0, qdrantReady: true };
      const data = (await res.json()) as any;
      return {
        points: data.result?.points_count ?? 0,
        qdrantReady: true,
      };
    } catch {
      return { points: 0, qdrantReady: false };
    }
  }
}

export const memoryStore = new MemoryStore();

// Initialize Qdrant collection on import (best-effort)
ensureMemoryCollection().catch(() => {});
