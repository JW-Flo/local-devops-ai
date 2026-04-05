import { config } from "../config.js";
import { knowledgeStore } from "../knowledge/store.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";

const GITHUB_API = "https://api.github.com";

const CONTEXT_EXTENSIONS = [".md", ".txt", ".yaml", ".yml", ".tf", ".toml"];
const MAX_SYNC_SIZE = 100_000;
const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", ".next", ".cache",
  "__pycache__", ".wrangler", ".terraform", ".venv",
]);

function chunkText(text: string, size = 1000): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}
// ── Dynamic Repo Registry ──

export type RepoEntry = {
  owner: string;   // org or user
  name: string;
  addedAt: string;
  lastSynced?: string;
};

const REGISTRY_PATH = resolve(config.cacheDir, "github-repos.json");

function loadRegistry(): RepoEntry[] {
  try {
    if (existsSync(REGISTRY_PATH)) {
      return JSON.parse(readFileSync(REGISTRY_PATH, "utf8")) as RepoEntry[];
    }
  } catch { /* corrupt file */ }
  // Seed with defaults
  const defaults: RepoEntry[] = [
    { owner: "JW-Flo", name: "AWhittleWandering", addedAt: new Date().toISOString() },
    { owner: "JW-Flo", name: "Project-AtlasIT", addedAt: new Date().toISOString() },
  ];
  saveRegistry(defaults);
  return defaults;
}

function saveRegistry(entries: RepoEntry[]): void {
  const dir = dirname(REGISTRY_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(REGISTRY_PATH, JSON.stringify(entries, null, 2));
}

let registry: RepoEntry[] = loadRegistry();

export function getRegistry(): RepoEntry[] {
  return [...registry];
}

export function addRepo(owner: string, name: string): RepoEntry {
  const existing = registry.find((r) => r.owner === owner && r.name === name);
  if (existing) return existing;
  const entry: RepoEntry = { owner, name, addedAt: new Date().toISOString() };
  registry.push(entry);
  saveRegistry(registry);
  return entry;
}

export function removeRepo(owner: string, name: string): boolean {
  const idx = registry.findIndex((r) => r.owner === owner && r.name === name);
  if (idx === -1) return false;
  registry.splice(idx, 1);
  saveRegistry(registry);
  return true;
}
// ── GitHub API Client ──

export class GitHubTool {
  private token: string;

  constructor(token?: string) {
    this.token = token ?? config.ghPat ?? "";
  }

  updateToken(newToken: string): void {
    this.token = newToken;
  }

  private headers() {
    return {
      Authorization: `token ${this.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    };
  }

  private async api<T>(path: string, init?: RequestInit, retries = 3): Promise<T> {
    for (let attempt = 0; attempt < retries; attempt++) {
      const res = await fetch(`${GITHUB_API}${path}`, {
        headers: this.headers(), ...init,
      });
      if (res.status === 401 && attempt < retries - 1) {
        const delay = 1000 * Math.pow(2, attempt);
        console.warn(`[github] 401 on ${path}, retry in ${delay}ms (attempt ${attempt + 1})`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`GitHub ${res.status}: ${body.slice(0, 300)}`);
      }
      return (await res.json()) as T;
    }
    throw new Error("GitHub API retries exhausted");
  }
  // ── Repo discovery ──

  async discoverOrgRepos(owner: string): Promise<Array<{ name: string; default_branch: string; url: string }>> {
    // Try org endpoint first, fall back to user endpoint
    let repos: Array<{ name: string; default_branch: string; html_url: string }> = [];
    try {
      repos = await this.api<typeof repos>(`/orgs/${owner}/repos?per_page=100&sort=updated`);
    } catch {
      try {
        repos = await this.api<typeof repos>(`/users/${owner}/repos?per_page=100&sort=updated`);
      } catch (err) {
        throw new Error(`Cannot list repos for ${owner}: ${(err as Error).message}`);
      }
    }
    return repos.map((r) => ({ name: r.name, default_branch: r.default_branch, url: r.html_url }));
  }

  async listRepos(): Promise<Array<{ owner: string; name: string; default_branch: string; url: string; addedAt: string; lastSynced?: string }>> {
    const entries = getRegistry();
    const results = await Promise.allSettled(
      entries.map(async (entry) => {
        const data = await this.api<{ name: string; default_branch: string; html_url: string }>(
          `/repos/${entry.owner}/${entry.name}`,
        );
        return { ...entry, default_branch: data.default_branch, url: data.html_url };
      }),
    );
    return results
      .filter((r): r is PromiseFulfilledResult<any> => r.status === "fulfilled")
      .map((r) => r.value);
  }
  async getDefaultBranch(owner: string, repo: string): Promise<string> {
    const data = await this.api<{ default_branch: string }>(`/repos/${owner}/${repo}`);
    return data.default_branch;
  }

  async getTree(owner: string, repo: string, branch?: string): Promise<Array<{ path: string; type: string; size?: number }>> {
    const ref = branch ?? (await this.getDefaultBranch(owner, repo));
    const data = await this.api<{ tree: Array<{ path: string; type: string; size?: number }> }>(
      `/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`,
    );
    return data.tree
      .filter((item) => !item.path.split("/").some((seg) => SKIP_DIRS.has(seg)))
      .map((item) => ({ path: item.path, type: item.type, size: item.size }));
  }

  async getFile(owner: string, repo: string, path: string, branch?: string): Promise<{ content: string; sha: string }> {
    const ref = branch ?? (await this.getDefaultBranch(owner, repo));
    const data = await this.api<{ content: string; sha: string; encoding: string }>(
      `/repos/${owner}/${repo}/contents/${path}?ref=${ref}`,
    );
    const content = data.encoding === "base64"
      ? Buffer.from(data.content, "base64").toString("utf8")
      : data.content;
    return { content, sha: data.sha };
  }

  async createBranch(owner: string, repo: string, branchName: string, baseBranch?: string): Promise<{ ref: string; sha: string }> {
    const base = baseBranch ?? (await this.getDefaultBranch(owner, repo));
    const baseRef = await this.api<{ object: { sha: string } }>(`/repos/${owner}/${repo}/git/ref/heads/${base}`);
    const data = await this.api<{ ref: string; object: { sha: string } }>(
      `/repos/${owner}/${repo}/git/refs`,
      { method: "POST", body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: baseRef.object.sha }) },
    );
    return { ref: data.ref, sha: data.object.sha };
  }
  async commitFile(owner: string, repo: string, branch: string, path: string, content: string, message: string, existingSha?: string): Promise<{ sha: string; url: string }> {
    const body: Record<string, unknown> = {
      message, content: Buffer.from(content).toString("base64"), branch,
    };
    if (existingSha) body.sha = existingSha;
    const data = await this.api<{ commit: { sha: string; html_url: string } }>(
      `/repos/${owner}/${repo}/contents/${path}`, { method: "PUT", body: JSON.stringify(body) },
    );
    return { sha: data.commit.sha, url: data.commit.html_url };
  }

  async createPR(owner: string, repo: string, head: string, title: string, body: string, base?: string): Promise<{ number: number; url: string }> {
    const baseBranch = base ?? (await this.getDefaultBranch(owner, repo));
    const data = await this.api<{ number: number; html_url: string }>(
      `/repos/${owner}/${repo}/pulls`,
      { method: "POST", body: JSON.stringify({ title, body, head, base: baseBranch }) },
    );
    return { number: data.number, url: data.html_url };
  }

  async requestReview(owner: string, repo: string, prNumber: number, reviewers: string[] = ["copilot-pull-request-reviewer"]): Promise<void> {
    await this.api(`/repos/${owner}/${repo}/pulls/${prNumber}/requested_reviewers`, {
      method: "POST", body: JSON.stringify({ reviewers }),
    });
  }

  async mergePR(owner: string, repo: string, prNumber: number, method: "squash" | "merge" | "rebase" = "squash"): Promise<{ sha: string; merged: boolean }> {
    return this.api<{ sha: string; merged: boolean }>(
      `/repos/${owner}/${repo}/pulls/${prNumber}/merge`,
      { method: "PUT", body: JSON.stringify({ merge_method: method }) },
    );
  }

  // 🔌 Review polling (Copilot review loop) 🔌

  async getReviews(owner: string, repo: string, prNumber: number): Promise<Array<{ id: number; user: string; state: string; body: string; submittedAt: string }>> {
    const data = await this.api<Array<{ id: number; user: { login: string } | null; state: string; body: string; submitted_at: string }>>(
      `/repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
    );
    return data.map((r) => ({
      id: r.id,
      user: r.user?.login ?? "unknown",
      state: r.state,  // APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED | PENDING
      body: r.body ?? "",
      submittedAt: r.submitted_at,
    }));
  }

  async getReviewComments(owner: string, repo: string, prNumber: number): Promise<Array<{ id: number; path: string; line: number | null; body: string; user: string; inReplyToId?: number }>> {
    const data = await this.api<Array<{ id: number; path: string; line: number | null; original_line: number | null; body: string; user: { login: string } | null; in_reply_to_id?: number }>>(
      `/repos/${owner}/${repo}/pulls/${prNumber}/comments`,
    );
    return data.map((c) => ({
      id: c.id,
      path: c.path,
      line: c.line ?? c.original_line,
      body: c.body,
      user: c.user?.login ?? "unknown",
      inReplyToId: c.in_reply_to_id,
    }));
  }

  async getPRStatus(owner: string, repo: string, prNumber: number): Promise<{ state: string; mergeable: boolean | null; mergeableState: string; reviewDecision: string | null }> {
    const data = await this.api<{ state: string; mergeable: boolean | null; mergeable_state: string }>(
      `/repos/${owner}/${repo}/pulls/${prNumber}`,
    );
    // Derive review decision from reviews
    const reviews = await this.getReviews(owner, repo, prNumber);
    const latestByUser = new Map<string, string>();
    for (const r of reviews) {
      if (r.state !== "PENDING" && r.state !== "COMMENTED") {
        latestByUser.set(r.user, r.state);
      }
    }
    const decisions = [...latestByUser.values()];
    const reviewDecision = decisions.includes("CHANGES_REQUESTED")
      ? "CHANGES_REQUESTED"
      : decisions.includes("APPROVED")
        ? "APPROVED"
        : null;
    return {
      state: data.state,
      mergeable: data.mergeable,
      mergeableState: data.mergeable_state,
      reviewDecision,
    };
  }

  async listOpenPRs(owner: string, repo: string): Promise<Array<{ number: number; title: string; head: string; body: string }>> {
    const data = await this.api<Array<{ number: number; title: string; head: { ref: string }; body: string }>>(
      `/repos/${owner}/${repo}/pulls?state=open&per_page=30`,
    );
    return data.map((pr) => ({
      number: pr.number,
      title: pr.title,
      head: pr.head.ref,
      body: pr.body ?? "",
    }));
  }

  async addPRComment(owner: string, repo: string, prNumber: number, body: string): Promise<{ id: number }> {
    return this.api<{ id: number }>(
      `/repos/${owner}/${repo}/issues/${prNumber}/comments`,
      { method: "POST", body: JSON.stringify({ body }) },
    );
  }

  async enableAutoMerge(owner: string, repo: string, prNumber: number, method: "SQUASH" | "MERGE" | "REBASE" = "SQUASH"): Promise<boolean> {
    // Get PR node_id for GraphQL
    try {
      const pr = await this.api<{ node_id: string }>(`/repos/${owner}/${repo}/pulls/${prNumber}`);
      const mutation = `mutation { enablePullRequestAutoMerge(input: {pullRequestId: "${pr.node_id}", mergeMethod: ${method}}) { pullRequest { autoMergeRequest { enabledAt } } } }`;
      await fetch("https://api.github.com/graphql", {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ query: mutation }),
      });
      console.log(`[github] auto-merge enabled for PR #${prNumber}`);
      return true;
    } catch (err) {
      console.warn(`[github] auto-merge failed (may need repo setting): ${(err as Error).message.slice(0, 100)}`);
      return false;
    }
  }

  async deleteBranch(owner: string, repo: string, branch: string): Promise<void> {
    await fetch(`${GITHUB_API}/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
      method: "DELETE", headers: this.headers(),
    });
  }
  // ── Knowledge sync ──

  async syncRepoContext(owner: string, repo: string): Promise<{ synced: number; skipped: number }> {
    const tree = await this.getTree(owner, repo);
    const contextFiles = tree.filter(
      (item) => item.type === "blob" &&
        CONTEXT_EXTENSIONS.some((ext) => item.path.endsWith(ext)) &&
        (item.size ?? 0) < MAX_SYNC_SIZE,
    );
    let synced = 0, skipped = 0;
    for (const file of contextFiles) {
      try {
        const { content } = await this.getFile(owner, repo, file.path);
        if (!content.trim()) { skipped++; continue; }
        const chunks = chunkText(content);
        await knowledgeStore.upsert(
          chunks.map((chunk, index) => ({
            id: `github:${owner}/${repo}:${file.path}::${index}`,
            text: chunk,
            metadata: { path: file.path, repo: `${owner}/${repo}`, source: "github", chunk: index },
          })),
        );
        synced++;
      } catch (err) {
        console.warn(`[github] sync failed for ${owner}/${repo}/${file.path}:`, (err as Error).message?.slice(0, 100));
        skipped++;
      }
    }
    // Update registry lastSynced
    const entry = registry.find((r) => r.owner === owner && r.name === repo);
    if (entry) { entry.lastSynced = new Date().toISOString(); saveRegistry(registry); }
    console.info(`[github] synced ${owner}/${repo}: ${synced} files, ${skipped} skipped`);
    return { synced, skipped };
  }
  async getRepoSummary(owner: string, repo: string): Promise<{ readme: string; structure: string[]; branch: string }> {
    const branch = await this.getDefaultBranch(owner, repo);
    let readme = "";
    try {
      const { content } = await this.getFile(owner, repo, "README.md");
      readme = content;
    } catch { readme = "(no README)"; }
    const tree = await this.getTree(owner, repo, branch);
    const topLevel = tree.filter((f) => !f.path.includes("/")).map((f) => `${f.type === "tree" ? "[DIR]" : "[FILE]"} ${f.path}`);
    return { readme, structure: topLevel, branch };
  }

  get managedRepos(): RepoEntry[] {
    return getRegistry();
  }
}

export const githubTool = new GitHubTool();