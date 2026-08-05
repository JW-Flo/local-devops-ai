import { fetchAllSources } from "../src/knowledge/fetcher.js";
import { KnowledgeIngester } from "../src/knowledge/ingester.js";

async function main() {
  console.log("[grow] fetching all sources (GH_PAT active for private repos)...");
  const f = await fetchAllSources();
  console.log(`[grow] fetched ${f.fetched} files; errors: ${JSON.stringify(f.errors)}`);
  console.log("[grow] ingesting (idempotent — only new/changed embed)...");
  await new KnowledgeIngester().ingest();
  console.log("[grow] DONE");
}
main().catch((e) => { console.error("[grow] FAIL", e); process.exit(1); });
