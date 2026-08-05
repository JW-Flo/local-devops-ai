import { readdir, readFile, stat } from "fs/promises";
import { join, relative } from "path";
import { config } from "../config.js";
import { knowledgeStore } from "./store.js";
import { loadSources } from "./fetcher.js";

const SUPPORTED_EXTENSIONS = [".md", ".txt", ".tf", ".tfvars", ".yaml", ".yml", ".json", ".ts", ".js"];
const SKIP_DIRS = new Set([".git", "node_modules", "dist", ".next", ".cache", "__pycache__", ".wrangler", ".terraform"]);
const MAX_FILE_SIZE = 100_000; // skip files > 100KB

function chunkText(text: string, chunkSize = 1000): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize));
  }
  // Drop garbage chunks (lone punctuation / whitespace, e.g. trailing "}" or ")").
  return chunks.filter((c) => c.replace(/[^a-zA-Z0-9]/g, "").length >= 20);
}

async function walk(dir: string, files: string[] = []): Promise<string[]> {
  const entries = await readdir(dir);
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    const info = await stat(path);
    if (info.isDirectory()) {
      await walk(path, files);
    } else {
      if (info.size > MAX_FILE_SIZE) continue;
      if (SUPPORTED_EXTENSIONS.some((ext) => entry.endsWith(ext))) {
        files.push(path);
      }
    }
  }
  return files;
}

export class KnowledgeIngester {
  constructor(private readonly root = config.knowledgeRoot) {}

  async ingest(): Promise<void> {
    const files = await walk(this.root, []);
    console.info(`[knowledge] ingesting ${files.length} files`);

    // Provenance: map each top-level source dir → { source id, license, url }
    const provByDir = new Map<string, { source: string; license?: string; url?: string }>();
    for (const s of loadSources()) {
      provByDir.set(s.dir, {
        source: s.id,
        license: (s as { license?: string }).license,
        url: (s as { url?: string }).url,
      });
    }

    let ok = 0;
    let fail = 0;
    for (const filePath of files) {
      try {
        const text = await readFile(filePath, "utf8");
        if (!text.trim()) continue;
        const chunks = chunkText(text);
        const rel = relative(this.root, filePath);
        const topDir = rel.split(/[\\/]/)[0];
        const prov = provByDir.get(topDir) ?? {};
        await knowledgeStore.upsert(
          chunks.map((chunk, index) => ({
            id: `${rel}::${index}`,
            text: chunk,
            metadata: {
              path: rel,
              chunk: index,
              ...prov,
            },
          })),
        );
        ok++;
      } catch (err) {
        fail++;
        console.warn(`[knowledge] failed to ingest ${filePath}:`, (err as Error).message);
      }
    }
    console.info(`[knowledge] ingest complete: ${ok} files ok, ${fail} failed`);
  }
}
