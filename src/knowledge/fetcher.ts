/**
 * Knowledge Fetcher — auto-discovers and downloads external documentation
 * sources (API docs, platform docs, GitHub repos) into the knowledge root
 * for ingestion by the existing KnowledgeIngester.
 *
 * Sources are defined in D:/ai-knowledge/_sources.json and fetched on a
 * configurable interval. Each source is stored in a subdirectory under
 * the knowledge root.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, basename } from "path";
import { config } from "../config.js";

export type KnowledgeSource = {
  id: string;
  type: "github-repo" | "url" | "github-wiki";
  /** For github-repo: "owner/repo", for url: the full URL */
  target: string;
  /** Subdirectory name under knowledge root */
  dir: string;
  /** Glob patterns to include (github only). Default: ["*.md", "*.ts", "*.yaml"] */
  include?: string[];
  /** Whether this source is active */
  enabled: boolean;
  /** Last successful fetch ISO timestamp */
  lastFetched?: string;
};

const SOURCES_FILE = "_sources.json";
const DEFAULT_INCLUDE = ["*.md", "*.txt", "*.yaml", "*.yml", "*.json", "*.ts", "*.tf"];

function getSourcesPath(): string {
  return join(config.knowledgeRoot, SOURCES_FILE);
}

export function loadSources(): KnowledgeSource[] {
  const path = getSourcesPath();
  if (!existsSync(path)) {
    // Seed with default sources
    const defaults: KnowledgeSource[] = [
      {
        id: "cloudflare-workers-docs",
        type: "github-repo",
        target: "cloudflare/cloudflare-docs",
        dir: "cloudflare-docs",
        include: ["*.md"],
        enabled: false, // user enables when ready
      },
      {
        id: "hono-docs",
        type: "github-repo",
        target: "honojs/hono",
        dir: "hono-docs",
        include: ["*.md", "*.ts"],
        enabled: false,
      },
    ];
    writeFileSync(path, JSON.stringify({ sources: defaults }, null, 2));
    return defaults;
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return raw.sources ?? [];
  } catch {
    return [];
  }
}

export function saveSources(sources: KnowledgeSource[]): void {
  writeFileSync(getSourcesPath(), JSON.stringify({ sources }, null, 2));
}

/** Fetch a GitHub repo's documentation files via the GitHub API (tree endpoint) */
async function fetchGitHubRepo(source: KnowledgeSource): Promise<number> {
  const pat = config.ghPat;
  const headers: Record<string, string> = { Accept: "application/vnd.github.v3+json" };
  if (pat) headers.Authorization = `token ${pat}`;

  const [owner, repo] = source.target.split("/");
  if (!owner || !repo) throw new Error(`Invalid github-repo target: ${source.target}`);

  // Get default branch
  const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
  if (!repoRes.ok) throw new Error(`GitHub API ${repoRes.status} for ${source.target}`);
  const repoData = (await repoRes.json()) as any;
  const branch = repoData.default_branch ?? "main";

  // Get file tree (recursive)
  const treeRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
    { headers }
  );
  if (!treeRes.ok) throw new Error(`GitHub tree API ${treeRes.status}`);
  const treeData = (await treeRes.json()) as any;

  const includePatterns = source.include ?? DEFAULT_INCLUDE;
  const matchesPattern = (path: string): boolean => {
    const name = basename(path);
    return includePatterns.some((pattern) => {
      if (pattern.startsWith("*.")) {
        return name.endsWith(pattern.slice(1));
      }
      return name === pattern;
    });
  };

  // Filter and download matching files
  const files = (treeData.tree as any[])
    .filter((f: any) => f.type === "blob" && matchesPattern(f.path))
    .filter((f: any) => !f.path.includes("node_modules/") && !f.path.includes("dist/"))
    .slice(0, 200); // cap to avoid rate limits

  const outDir = join(config.knowledgeRoot, source.dir);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  let fetched = 0;
  for (const file of files) {
    try {
      // Use raw.githubusercontent.com for content (no API rate limit)
      const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${file.path}`;
      const contentRes = await fetch(rawUrl);
      if (!contentRes.ok) continue;
      const content = await contentRes.text();
      if (!content.trim()) continue;

      // Flatten path: src/docs/guide.md -> src_docs_guide.md
      const flatName = file.path.replace(/\//g, "_");
      const outPath = join(outDir, flatName);
      writeFileSync(outPath, content, "utf8");
      fetched++;
    } catch {
      // Skip individual file failures
      continue;
    }
  }

  return fetched;
}

/** Fetch a single URL and save its content */
async function fetchUrl(source: KnowledgeSource): Promise<number> {
  const outDir = join(config.knowledgeRoot, source.dir);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const res = await fetch(source.target);
  if (!res.ok) throw new Error(`URL fetch ${res.status}: ${source.target}`);
  const content = await res.text();
  if (!content.trim()) return 0;

  const filename = basename(new URL(source.target).pathname) || "index.md";
  writeFileSync(join(outDir, filename), content, "utf8");
  return 1;
}

/** Run a single fetch cycle for all enabled sources */
export async function fetchAllSources(): Promise<{ fetched: number; errors: string[] }> {
  const sources = loadSources();
  const enabled = sources.filter((s) => s.enabled);
  if (!enabled.length) {
    console.log("[knowledge-fetcher] no enabled sources");
    return { fetched: 0, errors: [] };
  }

  let totalFetched = 0;
  const errors: string[] = [];

  for (const source of enabled) {
    try {
      console.log(`[knowledge-fetcher] fetching ${source.type}: ${source.target}`);
      let count = 0;

      switch (source.type) {
        case "github-repo":
        case "github-wiki":
          count = await fetchGitHubRepo(source);
          break;
        case "url":
          count = await fetchUrl(source);
          break;
        default:
          errors.push(`Unknown source type: ${(source as any).type}`);
          continue;
      }

      totalFetched += count;
      source.lastFetched = new Date().toISOString();
      console.log(`[knowledge-fetcher] ${source.id}: ${count} files fetched`);
    } catch (err) {
      const msg = `${source.id}: ${(err as Error).message}`;
      errors.push(msg);
      console.warn(`[knowledge-fetcher] ${msg}`);
    }
  }

  // Persist updated lastFetched timestamps
  saveSources(sources);

  return { fetched: totalFetched, errors };
}
