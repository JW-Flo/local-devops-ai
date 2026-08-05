import { createHash } from "crypto";
import { config } from "../config.js";

type KnowledgeChunk = {
  id: string;
  text: string;
  metadata: Record<string, unknown>;
};

export class KnowledgeStore {
  private readonly collectionName = "devops_ai_docs";

  async ensureCollection(): Promise<void> {
    await fetch(`${config.qdrantUrl}/collections/${this.collectionName}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vectors: {
          size: config.embedDimensions,
          distance: "Cosine",
        },
      }),
    });
  }

  private async embed(text: string): Promise<number[]> {
    const res = await fetch(`${config.ollamaHost}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: config.embedModel, prompt: text }),
    });
    if (!res.ok) {
      throw new Error(`Embedding error: ${res.statusText}`);
    }
    const data = (await res.json()) as { embedding: number[] };
    return data.embedding;
  }

  private stringToUUID(str: string): string {
    // Deterministic UUID v5-like hash from string using simple hash
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    const hex = Math.abs(hash).toString(16).padStart(8, '0');
    // Build a second hash for more entropy
    let hash2 = 5381;
    for (let i = 0; i < str.length; i++) {
      hash2 = ((hash2 << 5) + hash2) + str.charCodeAt(i);
      hash2 = hash2 & hash2;
    }
    const hex2 = Math.abs(hash2).toString(16).padStart(8, '0');
    return `${hex.slice(0,8)}-${hex.slice(0,4)}-4${hex.slice(1,4)}-8${hex2.slice(0,3)}-${hex2.padEnd(12, '0').slice(0,12)}`;
  }

  private sanitizeText(text: string): string {
    // Strip control chars, null bytes, and all backslash-hex/unicode escape
    // sequences that break Qdrant's JSON parser
    return text
      .replace(/\0/g, '')
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ')
      // Remove ALL \xNN patterns (literal backslash + x + hex) — these break Qdrant JSON
      .replace(/\\x[0-9a-fA-F]{1,2}/g, '')
      // Remove incomplete \uNNNN patterns
      .replace(/\\u[0-9a-fA-F]{0,4}/g, '')
      // Remove other problematic escape sequences
      .replace(/\\[0-7]{1,3}/g, '')
      // Collapse any resulting double-spaces
      .replace(/  +/g, ' ');
  }

  private contentHash(text: string): string {
    return createHash("sha1").update(text).digest("hex");
  }

  /** Look up stored content-hashes for a set of point IDs (for idempotent skip). */
  private async existingHashes(ids: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    try {
      const res = await fetch(`${config.qdrantUrl}/collections/${this.collectionName}/points`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, with_payload: ["hash"], with_vector: false }),
      });
      if (!res.ok) return map;
      const data = (await res.json()) as { result?: Array<{ id: string; payload?: { hash?: string } }> };
      for (const p of data.result ?? []) {
        if (p.payload?.hash) map.set(String(p.id), p.payload.hash);
      }
    } catch {
      // On any error, treat as nothing-existing (safe: we re-embed).
    }
    return map;
  }

  async upsert(chunks: KnowledgeChunk[]): Promise<void> {
    if (!chunks.length) return;
    // Process in batches of 10 to avoid overwhelming Ollama
    const BATCH_SIZE = 10;
    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE).map((chunk) => ({
        chunk,
        id: this.stringToUUID(chunk.id),
        hash: this.contentHash(chunk.text),
      }));

      // Idempotent skip: only (re)embed chunks whose content-hash changed.
      const existing = await this.existingHashes(batch.map((b) => b.id));
      const todo = batch.filter((b) => existing.get(b.id) !== b.hash);
      if (!todo.length) continue;

      const vectors = await Promise.all(
        todo.map(async (b) => ({
          id: b.id,
          vector: await this.embed(b.chunk.text),
          payload: {
            text: this.sanitizeText(b.chunk.text),
            hash: b.hash,
            ...b.chunk.metadata,
          },
        })),
      );

      const body = JSON.stringify({ points: vectors });
      const res = await fetch(`${config.qdrantUrl}/collections/${this.collectionName}/points?wait=true`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body,
      });
      if (!res.ok) {
        const errText = await res.text();
        console.error(`Qdrant upsert failed (${res.status}): ${errText.slice(0, 200)}`);
      }
    }
  }

  async query(prompt: string, limit = 5): Promise<string[]> {
    const vector = await this.embed(prompt);
    const res = await fetch(`${config.qdrantUrl}/collections/${this.collectionName}/points/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vector, limit, with_payload: true }),
    });
    if (!res.ok) {
      throw new Error(`Qdrant search failed: ${res.statusText}`);
    }
    const data = (await res.json()) as {
      result: Array<{ payload: { text: string } }>;
    };
    return data.result?.map((r) => r.payload.text) ?? [];
  }

  async stats(): Promise<{ points: number }> {
    const res = await fetch(`${config.qdrantUrl}/collections/${this.collectionName}`);
    if (!res.ok) {
      throw new Error(`Qdrant stats failed: ${res.statusText}`);
    }
    const data = (await res.json()) as { result?: { points_count?: number; vectors_count?: number } };
    const points = data.result?.points_count ?? data.result?.vectors_count ?? 0;
    return { points };
  }
}

export const knowledgeStore = new KnowledgeStore();
await knowledgeStore.ensureCollection().catch((err) => {
  console.warn("Knowledge collection ensure failed", err);
});
