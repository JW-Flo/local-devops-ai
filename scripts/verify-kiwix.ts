import { KiwixTool } from "../src/tools/kiwix.js";
import { config } from "../src/config.js";

async function main() {
  console.log("KIWIX_URL:", config.kiwixUrl);
  const t = new KiwixTool();
  console.log("isAvailable:", await t.isAvailable());

  const results = await t.search("photosynthesis", 3);
  console.log("search 'photosynthesis' ->", results.length, "results");
  results.forEach((r) => console.log("  -", r.title));

  if (results[0]) {
    const art = await t.getArticle(results[0].path);
    console.log("article:", art.title, "| text length:", art.text.length);
    console.log("  excerpt:", art.text.slice(0, 160));
  }
  console.log("KIWIX-VERIFY-PASS");
}
main().catch((e) => { console.error("KIWIX-VERIFY-FAIL:", e instanceof Error ? e.message : e); process.exit(1); });
