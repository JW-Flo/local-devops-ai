import { config } from "./config.js";
import { githubTool, getRegistry } from "./tools/github.js";
import { knowledgeStore } from "./knowledge/store.js";
import { memoryStore } from "./memory/store.js";
import { broadcast } from "./events.js";
import { callBedrock } from "./bedrock.js";
import { callOpenRouter } from "./openrouter.js";
import { isProviderAvailable, logIssue } from "./self-healer.js";
import { recommendProvider, recordUsage, type ProviderName } from "./rate-limiter.js";

export type RoadmapItem = {
  id: string;
  title: string;
  description: string;
  priority: "critical" | "high" | "medium" | "low";
  status: "planned" | "in-progress" | "done" | "blocked";
  repo: string;
  tasks: GeneratedTask[];
};

export type GeneratedTask = {
  id: string;
  title: string;
  objective: string;
  type: "plan" | "code" | "diagnose" | "review";
  tools: string[];
  contextPaths: string[];
  reasoning: string;
  estimatedComplexity: "trivial" | "small" | "medium" | "large";
  dependencies: string[];
};

export type AgentState = {
  lastRun: string | null;
  running: boolean;
  roadmapItems: RoadmapItem[];
  generatedTasks: GeneratedTask[];
  errors: string[];
};

const state: AgentState = {
  lastRun: null, running: false,
  roadmapItems: [], generatedTasks: [], errors: [],
};

export function resetAgentState(): void {
  state.running = false;
  state.errors = [];
  state.roadmapItems = [];
  state.generatedTasks = [];
}

export function getAgentState(): AgentState {
  return { ...state };
}

const ROADMAP_FILES = [
  "ROADMAP.md", "roadmap.md", "TODO.md", "TASKS.md",
  "docs/ROADMAP.md", "docs/roadmap.md", "docs/WORK_ROADMAP.md",
  ".github/ROADMAP.md",
];

const TOOL_CATALOG = [
  { name: "github", desc: "read/write files, branches, PRs, sync repo context" },
  { name: "git", desc: "local git status, commit, apply patches" },
  { name: "shell", desc: "run CLI commands (npm, tsc, lint, test)" },
  { name: "terraform", desc: "plan/apply infrastructure" },
  { name: "kubernetes", desc: "kubectl operations" },
  { name: "docker", desc: "docker/compose operations" },
  { name: "ansible", desc: "run playbooks" },
  { name: "helm", desc: "chart install/upgrade" },
  { name: "flux", desc: "GitOps reconciliation" },
  { name: "observability", desc: "prometheus/loki/grafana queries" },
];

// ── Smart Multi-Provider LLM Routing ──
// Uses rate-limiter.ts to decide the best provider BEFORE calling.
// No more blind burst → 429 → paid fallback cascade.

/**
 * Call Ollama (CPU fallback, always available, zero cost).
 */
async function callOllama(
  system: string, user: string,
  opts?: { temp?: number; ctx?: number; model?: string }
): Promise<string> {
  const model = opts?.model ?? config.primaryModel;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 300_000);
  try {
    const res = await fetch(`${config.ollamaHost}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        stream: false,
        options: {
          temperature: opts?.temp ?? 0.1,
          num_ctx: opts?.ctx ?? 2048,
          num_gpu: Number(process.env.OLLAMA_NUM_GPU ?? 28),
        },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Ollama ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as any;
    return data.message?.content ?? "";
  } finally { clearTimeout(timeout); }
}

/**
 * Route a request to the recommended provider with smart fallback.
 * The rate-limiter decides which provider to use based on:
 *   - OpenRouter rate limit state (pacing, cooldowns)
 *   - Bedrock cost budget (hourly/daily caps)
 *   - Availability (circuit breakers)
 */
async function smartRoute(
  system: string, user: string,
  opts?: { temp?: number; ctx?: number }
): Promise<string> {
  const rec = recommendProvider();

  // If the recommended provider needs a delay, wait for it
  if (rec.delayMs > 0) {
    console.log(`[llm] smart-route: waiting ${Math.ceil(rec.delayMs / 1000)}s for ${rec.provider} — ${rec.reason}`);
    await new Promise((r) => setTimeout(r, rec.delayMs));
  }

  console.log(`[llm] smart-route → ${rec.provider} (${rec.reason})`);

  // Attempt the recommended provider, then fall through on failure
  const providers: ProviderName[] = [rec.provider];
  // Add fallbacks in order (skip the one we already tried)
  if (rec.provider !== "openrouter" && config.useOpenRouter && isProviderAvailable("openrouter")) {
    providers.push("openrouter");
  }
  if (rec.provider !== "bedrock" && config.useBedrock && isProviderAvailable("bedrock")) {
    providers.push("bedrock");
  }
  if (rec.provider !== "ollama") {
    providers.push("ollama");
  }

  for (const provider of providers) {
    try {
      switch (provider) {
        case "openrouter":
          if (!isProviderAvailable("openrouter")) continue;
          return await callOpenRouter(system, user, {
            temp: opts?.temp,
            maxTokens: opts?.ctx ?? config.maxTokens,
          });
        case "bedrock":
          if (!isProviderAvailable("bedrock")) continue;
          return await callBedrock(system, user, {
            temp: opts?.temp,
            maxTokens: opts?.ctx ?? config.maxTokens,
          });
        case "ollama":
          return await callOllama(system, user, opts);
      }
    } catch (err) {
      console.warn(`[llm] ${provider} failed, trying next: ${(err as Error).message.slice(0, 100)}`);
    }
  }

  throw new Error("All LLM providers exhausted");
}

/**
 * Call LLM via smart routing.
 * Rate-limit-aware: paces requests, respects budgets, minimizes cost.
 */
async function callLLM(system: string, user: string, opts?: { temp?: number; ctx?: number }): Promise<string> {
  return smartRoute(system, user, opts);
}

/**
 * Fast model — same smart routing, prefers free models.
 */
async function callFastLLM(system: string, user: string, opts?: { temp?: number; ctx?: number }): Promise<string> {
  return smartRoute(system, user, opts);
}

// ── Helpers ──

async function findRoadmap(owner: string, repo: string): Promise<string | null> {
  for (const path of ROADMAP_FILES) {
    try {
      const file = await githubTool.getFile(owner, repo, path);
      if (file && typeof file === "object" && "content" in file) {
        return (file as any).content as string;
      }
    } catch { continue; }
  }
  return null;
}

async function getRepoStructure(owner: string, repo: string): Promise<string> {
  try {
    const tree = await githubTool.getTree(owner, repo) as any;
    if (!tree?.tree) return "";
    const paths = (tree.tree as any[])
      .map((t: any) => t.path as string)
      .filter((p: string) =>
        !p.includes("node_modules") && !p.includes("dist/") &&
        !p.endsWith(".lock") && !p.endsWith("-lock.json")
      )
      .slice(0, 40);
    return paths.join("\n");
  } catch { return ""; }
}

function smartTruncateRoadmap(markdown: string, maxChars: number): string {
  const lines = markdown.split("\n");
  const prioritized: string[] = [];
  const deprioritized: string[] = [];
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.includes("[x]") || lower.includes("✅") || lower.includes("~~")) {
      deprioritized.push(line);
    } else {
      prioritized.push(line);
    }
  }
  let result = prioritized.join("\n");
  if (result.length < maxChars) {
    const remaining = maxChars - result.length;
    result += "\n\n# Completed:\n" + deprioritized.join("\n").slice(0, remaining);
  }
  return result.slice(0, maxChars);
}

function extractJSON(raw: string): any[] {
  const arrayMatch = raw.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try { return JSON.parse(arrayMatch[0]); } catch { /* fallback */ }
  }
  const objMatch = raw.match(/\{[\s\S]*?\}/g);
  if (objMatch) {
    const items: any[] = [];
    for (const m of objMatch) {
      try { items.push(JSON.parse(m)); } catch { continue; }
    }
    if (items.length) return items;
  }
  return [];
}

/** Build a compressed context briefing from knowledge + memories */
async function buildContextBriefing(item: RoadmapItem): Promise<string> {
  const parts: string[] = [];

  // 1. Qdrant knowledge (semantic search)
  try {
    const snippets = await knowledgeStore.query(`${item.title} ${item.description}`, 5);
    if (snippets.length) {
      parts.push("KNOWLEDGE:\n" + snippets.map((s, i) => `[${i + 1}] ${s.trim()}`).join("\n").slice(0, 800));
    }
  } catch { /* no qdrant */ }

  // 2. Past agent runs — what was already planned/attempted for similar items
  try {
    const pastRuns = await memoryStore.search(item.title, {
      source: "orchestrator-agent",
      limit: 3,
    });
    if (pastRuns.length) {
      const runSummary = pastRuns
        .map((m) => `[${m.createdAt.slice(0, 10)}] ${m.title}\n${m.details.slice(0, 200)}`)
        .join("\n");
      parts.push("PRIOR AGENT RUNS:\n" + runSummary.slice(0, 400));
    }
  } catch { /* no memories */ }

  // 3. Task-specific memories (keyword search)
  try {
    const keywords = item.title.split(/\s+/).slice(0, 3);
    const relevant = await memoryStore.search(keywords.join(" "), {
      tags: ["task"],
      limit: 3,
    });
    if (relevant.length) {
      const taskHistory = relevant
        .map((m) => `- ${m.title}: ${m.details.slice(0, 150)}`)
        .join("\n");
      parts.push("RELATED TASK HISTORY:\n" + taskHistory.slice(0, 300));
    }
  } catch { /* silent */ }

  return parts.join("\n\n") || "No prior context available.";
}

// ── Roadmap Parsing ──

async function parseRoadmapWithLLM(markdown: string, repoLabel: string): Promise<RoadmapItem[]> {
  const trimmed = smartTruncateRoadmap(markdown, 3000);
  const system = `You are a project manager parsing a software roadmap.
Extract ONLY top-level actionable items that are NOT yet completed.
IMPORTANT: Merge sub-bullets/sub-tasks into their parent item. Each parent feature or phase = ONE item. Do NOT create separate items for sub-bullets.
Deduplicate: if the same feature appears multiple times (e.g. under different phases), keep only ONE entry with the broadest scope.
Determine priority from language cues: urgent/critical/blocker=critical, important/next=high, should/nice=medium, maybe/later=low.
Determine status: planned if not started, in-progress if partially done, blocked if explicitly blocked.
Return ONLY a JSON array, no markdown, no explanation.`;

  const user = `Repository: ${repoLabel}

ROADMAP:
${trimmed}

Return JSON array (max 8 items):
[{"id":"kebab-slug","title":"short title","description":"1-2 sentence scope","priority":"high|medium|low|critical","status":"planned|in-progress|blocked"}]`;

  try {
    const raw = await callFastLLM(system, user);
    const items = extractJSON(raw);
    if (!items.length) return [];
    const mapped = items.map((item: any) => ({
      id: String(item.id ?? crypto.randomUUID().slice(0, 8)),
      title: String(item.title ?? "Untitled"),
      description: String(item.description ?? ""),
      priority: ["critical","high","medium","low"].includes(item.priority) ? item.priority : "medium",
      status: ["planned","in-progress","blocked"].includes(item.status) ? item.status : "planned",
      repo: repoLabel,
      tasks: [],
    }));
    // Deduplicate by title similarity (case-insensitive)
    const seen = new Set<string>();
    return mapped.filter((item) => {
      const key = item.title.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  } catch (err) {
    state.errors.push(`parseRoadmap(${repoLabel}): ${(err as Error).message}`);
    return [];
  }
}

// ── Task Generation (memory + knowledge aware) ──

async function generateTasksForItem(
  item: RoadmapItem,
  repoStructure: string,
): Promise<GeneratedTask[]> {
  // Build rich context from knowledge store + memory store
  console.log(`[agent]   gathering context for: ${item.title}`);
  const contextBriefing = await buildContextBriefing(item);
  const toolList = TOOL_CATALOG.map((t) => `${t.name}: ${t.desc}`).join("\n");

  const system = `You are a senior engineer decomposing a roadmap item into implementable tasks.
Each task must be a single atomic unit of work one developer can complete.
For code tasks: specify exact files to create/modify in contextPaths.
Pick tools from the available catalog. Consider prior work to avoid duplication.
Return ONLY a JSON array.`;

  const user = `ROADMAP ITEM: ${item.title} (${item.priority}, repo: ${item.repo})
Description: ${item.description}

REPO STRUCTURE:
${repoStructure.slice(0, 500) || "unknown"}

TOOLS:
${toolList}

CONTEXT (knowledge + prior runs + task history):
${contextBriefing.slice(0, 1000)}

Generate 1-5 tasks as JSON array:
[{"id":"task-slug","title":"imperative title","objective":"Specific deliverable with file paths","type":"code|plan|diagnose|review","tools":["github","shell"],"contextPaths":["src/file.ts"],"reasoning":"Why needed, what it unblocks","estimatedComplexity":"trivial|small|medium|large","dependencies":["other-id"]}]
Rules: code=writing files, plan=research/design, diagnose=debugging, review=audit. Include "github" for code tasks. Order by dependency.`;

  try {
    const raw = await callFastLLM(system, user, { temp: 0.15, ctx: 3072 });
    const tasks = extractJSON(raw);
    if (!tasks.length) return [];
    return tasks.map((t: any) => ({
      id: String(t.id ?? crypto.randomUUID().slice(0, 8)),
      title: String(t.title ?? "Untitled task"),
      objective: String(t.objective ?? t.title ?? ""),
      type: ["code","plan","diagnose","review"].includes(t.type) ? t.type : "plan",
      tools: Array.isArray(t.tools) ? t.tools.filter((tool: string) => TOOL_CATALOG.some((c) => c.name === tool)) : [],
      contextPaths: Array.isArray(t.contextPaths) ? t.contextPaths : [],
      reasoning: String(t.reasoning ?? ""),
      estimatedComplexity: ["trivial","small","medium","large"].includes(t.estimatedComplexity) ? t.estimatedComplexity : "medium",
      dependencies: Array.isArray(t.dependencies) ? t.dependencies : [],
    }));
  } catch (err) {
    state.errors.push(`generateTasks(${item.id}): ${(err as Error).message}`);
    return [];
  }
}

// ── VRAM Management ──

async function unloadAllModels(): Promise<void> {
  try {
    const ps = await fetch(`${config.ollamaHost}/api/ps`);
    if (!ps.ok) return;
    const data = (await ps.json()) as any;
    for (const m of data.models ?? []) {
      // Skip embed model — knowledge watcher needs it resident
      if (m.name.includes("embed")) continue;
      await fetch(`${config.ollamaHost}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: m.name, keep_alive: 0, stream: false }),
      }).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 1000));
  } catch { /* best effort */ }
}

// ── Main Agent Run ──

export async function runAgent(): Promise<AgentState> {
  if (state.running) return state;
  state.running = true;
  state.errors = [];

  console.log(`[agent] starting run — provider: ${config.llmProvider}`);
  console.log("[agent] unloading all models before run...");
  await unloadAllModels();

  const repoEntries = getRegistry();
  broadcast("orchestrator:roadmap", {
    status: "scanning",
    repos: repoEntries.map((r) => `${r.owner}/${r.name}`),
  });

  try {
    const allItems: RoadmapItem[] = [];

    for (const entry of repoEntries) {
      const repoLabel = `${entry.owner}/${entry.name}`;
      console.log(`[agent] scanning ${repoLabel} for roadmap...`);
      const markdown = await findRoadmap(entry.owner, entry.name);
      if (!markdown) {
        state.errors.push(`No roadmap found in ${repoLabel}`);
        continue;
      }

      console.log(`[agent] fetching file tree for ${repoLabel}...`);
      const repoStructure = await getRepoStructure(entry.owner, entry.name);

      console.log(`[agent] parsing roadmap for ${repoLabel} via LLM...`);
      const items = await parseRoadmapWithLLM(markdown, repoLabel);
      console.log(`[agent] ${repoLabel}: parsed ${items.length} roadmap items`);
      broadcast("orchestrator:roadmap", { repo: repoLabel, items: items.length });

      for (const item of items) {
        if (item.status === "done") {
          item.tasks = [];
        } else {
          console.log(`[agent] generating tasks for: ${item.title}...`);
          item.tasks = await generateTasksForItem(item, repoStructure);
          console.log(`[agent] ${item.title}: ${item.tasks.length} tasks generated`);
          broadcast("orchestrator:task", {
            roadmapItem: item.title,
            tasks: item.tasks.map((t) => ({ id: t.id, title: t.title, type: t.type, tools: t.tools })),
          });
        }
        allItems.push(item);
      }
    }

    state.roadmapItems = allItems;
    state.generatedTasks = allItems.flatMap((item) => item.tasks);
    state.lastRun = new Date().toISOString();

    const summary = allItems
      .map((i) => {
        const taskDetail = i.tasks
          .map((t) => `  - [${t.type}] ${t.title} (${t.estimatedComplexity}, tools: ${t.tools.join(",") || "none"})`)
          .join("\n");
        return `[${i.repo}] ${i.title} (${i.priority}/${i.status}) → ${i.tasks.length} tasks\n${taskDetail}`;
      })
      .join("\n\n");

    await memoryStore.add({
      title: `Agent Run: ${allItems.length} roadmap items, ${state.generatedTasks.length} tasks`,
      details: summary,
      tags: ["agent", "roadmap", "auto-generated"],
      source: "orchestrator-agent",
    });

    broadcast("orchestrator:roadmap", {
      status: "complete",
      items: allItems.length,
      tasks: state.generatedTasks.length,
    });
  } catch (err) {
    state.errors.push(`runAgent: ${(err as Error).message}`);
    broadcast("orchestrator:roadmap", { status: "error", error: (err as Error).message });
  } finally {
    state.running = false;
  }

  return state;
}
