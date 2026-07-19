import { readdir, readFile, stat } from "fs/promises";
import { join, relative } from "path";
import { config } from "../config.js";
import { knowledgeStore } from "./store.js";
import { isBoskDocument, parseBosk } from "./chunkers/bosk.js";

const SUPPORTED_EXTENSIONS = [".md", ".txt", ".tf", ".tfvars", ".yaml", ".yml", ".json", ".ts", ".js"];
const SKIP_DIRS = new Set([".git", "node_modules", "dist", ".next", ".cache", "__pycache__", ".wrangler", ".terraform"]);
const MAX_FILE_SIZE = 100_000; // skip files > 100KB on the generic fixed-width path
/**
 * Large markdown is still walked so structural chunkers get a look at it — some
 * high-value references (e.g. the-book-of-secret-knowledge, a single 208KB
 * README) exceed MAX_FILE_SIZE and were previously dropped silently. Files that
 * no structural chunker claims are still skipped at ingest time.
 */
const MAX_STRUCTURAL_FILE_SIZE = 2_000_000;

function chunkText(text: string, chunkSize = 1000): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize));
  }
  return chunks;
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
      const cap = entry.endsWith(".md") ? MAX_STRUCTURAL_FILE_SIZE : MAX_FILE_SIZE;
      if (info.size > cap) continue;
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
    let ok = 0;
    let fail = 0;
    for (const filePath of files) {
      try {
        const text = await readFile(filePath, "utf8");
        if (!text.trim()) continue;
        const rel = relative(this.root, filePath);

        // Structural chunkers take precedence: they preserve command/description
        // boundaries that fixed-width slicing would cut through.
        if (isBoskDocument(rel, text)) {
          const boskChunks = parseBosk(text);
          console.info(`[knowledge] ${rel}: ${boskChunks.length} structural chunks`);
          await knowledgeStore.upsert(
            boskChunks.map((chunk) => ({
              id: chunk.id,
              text: chunk.text,
              metadata: { path: rel, ...chunk.metadata },
            })),
          );
          ok++;
          continue;
        }

        // Oversized files only survive the walk for structural chunkers.
        if (text.length > MAX_FILE_SIZE) {
          console.warn(`[knowledge] skipping oversized ${rel} (${text.length} bytes, no structural chunker)`);
          continue;
        }

        const chunks = chunkText(text);
        await knowledgeStore.upsert(
          chunks.map((chunk, index) => ({
            id: `${rel}::${index}`,
            text: chunk,
            metadata: {
              path: rel,
              chunk: index,
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
