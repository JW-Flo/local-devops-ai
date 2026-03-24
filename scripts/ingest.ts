import { KnowledgeIngester } from "../src/knowledge/ingester.js";

async function main() {
  const ingester = new KnowledgeIngester();
  await ingester.ingest();
  console.log("Knowledge ingestion complete");
}

main().catch((err) => {
  console.error("Ingestion failed", err);
  process.exit(1);
});
