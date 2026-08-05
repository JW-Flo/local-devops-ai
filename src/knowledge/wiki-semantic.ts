/**
 * Semantic Wikipedia — pre-embedded (bge-m3, 1024-d) passages loaded into the
 * `wikipedia_bge_m3` Qdrant collection. Queries are embedded locally with the
 * same bge-m3 model via Ollama, so retrieval is fully local and model-consistent.
 *
 * Loaded out-of-band from Upstash/wikipedia-2024-06-bge-m3 shards
 * (see ai-cache/wiki-bge/wiki-load.py). Extensible: load more shards for coverage.
 */
import { config } from "../config.js";

const WIKI_COLLECTION = "wikipedia_bge_m3";
const WIKI_MODEL = process.env.WIKI_EMBED_MODEL ?? "bge-m3";

export type WikiHit = { title: string; url: string; text: string; score: number };

async function embedBge(text: string): Promise<number[]> {
  const res = await fetch(`${config.ollamaHost}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: WIKI_MODEL, prompt: text }),
  });
  if (!res.ok) throw new Error(`bge-m3 embed ${res.status}`);
  return ((await res.json()) as { embedding: number[] }).embedding;
}

/** True if the semantic-Wikipedia collection exists and has data. */
export async function wikiCollectionReady(): Promise<boolean> {
  try {
    const res = await fetch(`${config.qdrantUrl}/collections/${WIKI_COLLECTION}`);
    if (!res.ok) return false;
    const d = (await res.json()) as { result?: { points_count?: number } };
    return (d.result?.points_count ?? 0) > 0;
  } catch {
    return false;
  }
}

/** Semantic search over pre-embedded Wikipedia (bge-m3). */
export async function semanticWiki(query: string, limit = 3): Promise<WikiHit[]> {
  const vector = await embedBge(query);
  const res = await fetch(`${config.qdrantUrl}/collections/${WIKI_COLLECTION}/points/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ vector, limit, with_payload: true }),
  });
  if (!res.ok) return [];
  const data = (await res.json()) as {
    result?: Array<{ payload: { title: string; url: string; text: string }; score: number }>;
  };
  return (data.result ?? []).map((r) => ({
    title: r.payload.title,
    url: r.payload.url,
    text: r.payload.text,
    score: r.score,
  }));
}
