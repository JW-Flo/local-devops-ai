import type { TaskRequest } from "../task-schema.js";
import { knowledgeStore } from "./store.js";
import { KiwixTool } from "../tools/kiwix.js";
import { semanticWiki, wikiCollectionReady } from "./wiki-semantic.js";

const kiwix = new KiwixTool();

/**
 * Build retrieval context for a task:
 *  1. Semantic hits from the local vector store (curated docs).
 *  2. If those are thin, augment with an offline-Wikipedia (Kiwix) keyword
 *     search so the agent still gets grounding for general-knowledge asks.
 * Each source is isolated — a failure in one never blocks the task.
 */
export async function getContextForTask(task: TaskRequest): Promise<string> {
  const parts: string[] = [];
  const STRONG = 0.55; // cosine-similarity threshold for a "relevant" hit

  // 1) Vector store (curated knowledge base) — keep only strong, non-trivial hits.
  let strongHits = 0;
  try {
    const scored = await knowledgeStore.queryScored(task.objective, 5);
    const strong = scored.filter((s) => s.score >= STRONG && s.text.trim().length > 30);
    strongHits = strong.length;
    if (strong.length) {
      parts.push(
        strong
          .map((s, idx) => `Context #${idx + 1} (score ${s.score.toFixed(2)}):\n${s.text.trim()}`)
          .join("\n---\n"),
      );
    }
  } catch (err) {
    console.warn("[context] vector retrieval failed:", (err as Error).message);
  }

  // 2) Semantic Wikipedia (bge-m3 pre-embedded) when docs are thin.
  if (strongHits < 2) {
    try {
      if (await wikiCollectionReady()) {
        const hits = (await semanticWiki(task.objective, 3)).filter((h) => h.score >= 0.5);
        if (hits.length) {
          parts.push(
            "Wikipedia (semantic):\n" +
              hits.map((h) => `- ${h.title}: ${h.text.slice(0, 240)}`).join("\n"),
          );
          strongHits += hits.length;
        }
      }
    } catch (err) {
      console.warn("[context] semantic wiki failed:", (err as Error).message);
    }
  }

  // 3) Offline-Wikipedia keyword fallback (Kiwix) when still thin.
  if (strongHits < 2) {
    try {
      if (await kiwix.isAvailable()) {
        const wiki = await kiwix.search(task.objective, 2);
        if (wiki.length) {
          parts.push(
            "Wikipedia (offline):\n" +
              wiki.map((w) => `- ${w.title}: ${w.snippet.slice(0, 240)}`).join("\n"),
          );
        }
      }
    } catch (err) {
      console.warn("[context] kiwix fallback failed:", (err as Error).message);
    }
  }

  return parts.join("\n---\n");
}
