import { knowledgeStore } from "../src/knowledge/store.js";
import { config } from "../src/config.js";
import { createHash } from "crypto";

const MARK = "qa-idem-marker";
const TEXT = "idempotency verification chunk " + Date.now();

async function scrollHash(): Promise<string | undefined> {
  const res = await fetch(`${config.qdrantUrl}/collections/devops_ai_docs/points/scroll`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filter: { must: [{ key: "path", match: { value: MARK } }] }, with_payload: true, limit: 1 }),
  });
  const d = (await res.json()) as { result?: { points?: Array<{ payload?: { hash?: string } }> } };
  return d.result?.points?.[0]?.payload?.hash;
}

async function main() {
  const chunk = { id: `${MARK}::0`, text: TEXT, metadata: { path: MARK, chunk: 0 } };
  await knowledgeStore.upsert([chunk]);
  const stored = await scrollHash();
  const expected = createHash("sha1").update(TEXT).digest("hex");
  console.log("stored:", stored, "\nexpected:", expected, "\nmatch:", stored === expected);
  await knowledgeStore.upsert([chunk]); // same content -> skip path (no throw)
  console.log("re-upsert (skip path) OK");
  await fetch(`${config.qdrantUrl}/collections/devops_ai_docs/points/delete`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filter: { must: [{ key: "path", match: { value: MARK } }] } }),
  });
  console.log(stored === expected ? "IDEM-VERIFY-PASS" : "IDEM-VERIFY-FAIL");
}
main().catch((e) => { console.error("IDEM-VERIFY-FAIL", e); process.exit(1); });
