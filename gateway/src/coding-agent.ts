/**
 * Coding Agent — reads repo files, generates code, creates branches + PRs.
 * Stack-aware: auto-detects framework, dependencies, and conventions per repo.
 * Provider chain: OpenRouter (free) → Bedrock → Ollama (GPU fallback)
 */

import { config } from "./config.js";
import { githubTool } from "./tools/github.js";
import { memoryStore } from "./memory/store.js";
import { broadcast } from "./events.js";
import { callBedrock } from "./bedrock.js";
import { callOpenRouter } from "./openrouter.js";
import { isProviderAvailable } from "./self-healer.js";
import { recommendProvider, type ProviderName } from "./rate-limiter.js";
import type { GeneratedTask } from "./agent.js";

export type CodingResult = {
  taskId: string;
  success: boolean;
  branch?: string;
  prUrl?: string;
  filesChanged: string[];
  error?: string;
};
// ── Stack Detection ──

type RepoStack = {
  framework: string;        // e.g. "hono", "express", "next", "react", "cf-workers", "node"
  language: string;         // "typescript" | "javascript"
  buildTool: string;        // "tsc", "vite", "wrangler", "esbuild", "webpack", "tsx"
  moduleSystem: string;     // "esm" | "commonjs"
  lintRules: string;        // summary of lint config
  keyDeps: string[];        // important dependencies
  conventions: string;      // detected patterns summary
  packageJson: string;      // raw (truncated) for LLM context
  tsConfig: string;         // raw (truncated) for LLM context
};

const CONFIG_FILES = [
  "package.json",
  "tsconfig.json",
  "wrangler.toml",
  "wrangler.jsonc",
  ".eslintrc.json",
  ".eslintrc.js",
  "eslint.config.js",
  "eslint.config.mjs",
  "biome.json",
  ".prettierrc",
  ".prettierrc.json",
];

/** Cache stack info per repo to avoid re-fetching within a cycle */
const stackCache = new Map<string, { stack: RepoStack; ts: number }>();
const STACK_CACHE_TTL = 10 * 60 * 1000; // 10 min

async function readGitHubFile(owner: string, repo: string, path: string): Promise<string | null> {
  try {
    const file = await githubTool.getFile(owner, repo, path) as any;
    return file?.content ? String(file.content) : null;
  } catch { return null; }
}

async function detectRepoStack(owner: string, repo: string): Promise<RepoStack> {
  const cacheKey = `${owner}/${repo}`;
  const cached = stackCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < STACK_CACHE_TTL) return cached.stack;

  console.log(`[coding-agent] Detecting stack for ${owner}/${repo}...`);

  // Read config files in parallel
  const configReads = CONFIG_FILES.map(f => readGitHubFile(owner, repo, f));
  const results = await Promise.all(configReads);
  const configs = new Map<string, string>();
  CONFIG_FILES.forEach((f, i) => { if (results[i]) configs.set(f, results[i]!); });

  const stack: RepoStack = {
    framework: "node",
    language: "javascript",
    buildTool: "node",
    moduleSystem: "commonjs",
    lintRules: "",
    keyDeps: [],
    conventions: "",
    packageJson: "",
    tsConfig: "",
  };
  // Parse package.json
  const pkgRaw = configs.get("package.json");
  if (pkgRaw) {
    stack.packageJson = pkgRaw.slice(0, 2000);
    try {
      const pkg = JSON.parse(pkgRaw);
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      const depNames = Object.keys(allDeps);
      stack.keyDeps = depNames.slice(0, 30);

      // Detect framework
      if (depNames.includes("hono")) stack.framework = "hono";
      else if (depNames.includes("next")) stack.framework = "next";
      else if (depNames.includes("express")) stack.framework = "express";
      else if (depNames.includes("fastify")) stack.framework = "fastify";
      else if (depNames.includes("react") && !depNames.includes("next")) stack.framework = "react";
      else if (depNames.includes("vue")) stack.framework = "vue";
      else if (depNames.includes("svelte")) stack.framework = "svelte";

      // Detect build tool
      if (depNames.includes("wrangler") || configs.has("wrangler.toml") || configs.has("wrangler.jsonc")) {
        stack.buildTool = "wrangler";
        if (stack.framework === "node") stack.framework = "cf-workers";
      }
      else if (depNames.includes("vite")) stack.buildTool = "vite";
      else if (depNames.includes("esbuild")) stack.buildTool = "esbuild";
      else if (depNames.includes("webpack")) stack.buildTool = "webpack";
      else if (depNames.includes("tsx")) stack.buildTool = "tsx";
      else if (depNames.includes("tsc") || depNames.includes("typescript")) stack.buildTool = "tsc";

      // Detect module system from package.json type field
      if (pkg.type === "module") stack.moduleSystem = "esm";
      else if (pkg.type === "commonjs") stack.moduleSystem = "commonjs";
      else stack.moduleSystem = depNames.includes("typescript") ? "esm" : "commonjs";

      // Build conventions summary from scripts
      if (pkg.scripts) {
        const scripts = Object.entries(pkg.scripts).slice(0, 10)
          .map(([k, v]) => `${k}: ${v}`).join("; ");
        stack.conventions += `Scripts: ${scripts}. `;
      }
    } catch { /* invalid package.json */ }
  }
  // Parse tsconfig
  const tsRaw = configs.get("tsconfig.json");
  if (tsRaw) {
    stack.language = "typescript";
    stack.tsConfig = tsRaw.slice(0, 1500);
    try {
      const ts = JSON.parse(tsRaw);
      const co = ts.compilerOptions || {};
      if (co.module?.toLowerCase().includes("esnext") || co.module?.toLowerCase().includes("es20")) {
        stack.moduleSystem = "esm";
      }
      const strictness = co.strict ? "strict" : "non-strict";
      const target = co.target || "unknown";
      stack.conventions += `TypeScript ${strictness}, target ${target}. `;
      if (co.paths) stack.conventions += `Path aliases configured. `;
      if (co.jsx) stack.conventions += `JSX: ${co.jsx}. `;
    } catch { /* invalid tsconfig */ }
  }

  // Parse wrangler config
  const wranglerToml = configs.get("wrangler.toml");
  const wranglerJsonc = configs.get("wrangler.jsonc");
  if (wranglerToml || wranglerJsonc) {
    stack.framework = "cf-workers";
    stack.buildTool = "wrangler";
    const wContent = (wranglerToml || wranglerJsonc)!;
    // Extract bindings info
    if (wContent.includes("[d1_databases]") || wContent.includes("d1_databases")) stack.conventions += "Uses D1 database. ";
    if (wContent.includes("[kv_namespaces]") || wContent.includes("kv_namespaces")) stack.conventions += "Uses KV namespace. ";
    if (wContent.includes("[r2_buckets]") || wContent.includes("r2_buckets")) stack.conventions += "Uses R2 storage. ";
    if (wContent.includes("durable_objects")) stack.conventions += "Uses Durable Objects. ";
    if (wContent.includes("compatibility_flags")) stack.conventions += "Has compat flags. ";
  }

  // Parse lint config
  for (const lintFile of [".eslintrc.json", ".eslintrc.js", "eslint.config.js", "eslint.config.mjs", "biome.json"]) {
    const lintRaw = configs.get(lintFile);
    if (lintRaw) {
      stack.lintRules = lintRaw.slice(0, 800);
      stack.conventions += `Linting: ${lintFile}. `;
      break;
    }
  }

  // Prettier config
  if (configs.has(".prettierrc") || configs.has(".prettierrc.json")) {
    stack.conventions += "Uses Prettier. ";
  }

  console.log(`[coding-agent] Stack: ${stack.framework}/${stack.language}/${stack.buildTool} (${stack.moduleSystem})`);
  stackCache.set(cacheKey, { stack, ts: Date.now() });
  return stack;
}
// ── Build stack-aware system prompt ──

function buildSystemPrompt(stack: RepoStack): string {
  const frameworkGuide: Record<string, string> = {
    "hono": `Framework: Hono (lightweight, CF Workers compatible).
Use \`Hono\` class, \`c.json()\`, \`c.text()\`, \`c.req.param()\`, \`c.req.query()\`.
Middleware via \`app.use()\`. Route groups via \`app.route()\`.
Error handling: \`app.onError((err, c) => c.json({error}, 500))\`.
Bindings accessed via \`c.env\` (D1, KV, R2, etc).`,
    "cf-workers": `Platform: Cloudflare Workers.
Export default handler: \`export default { fetch(request, env, ctx) {} }\`.
Use \`env\` for bindings (D1, KV, R2, Durable Objects). No Node.js built-ins.
Use Web APIs (fetch, Request, Response, Headers, URL, crypto).
Wrangler for dev/deploy. Workers have 128MB memory, 30s CPU time limit.`,
    "express": `Framework: Express.js.
Use \`req.params\`, \`req.query\`, \`req.body\`. Middleware via \`app.use()\`.
Error handling: 4-arg middleware \`(err, req, res, next)\`.
Router via \`express.Router()\`. Status codes via \`res.status(N).json()\`.`,
    "next": `Framework: Next.js (App Router preferred if tsconfig has paths).
Server components by default. Use 'use client' directive for client components.
API routes in app/api/. Data fetching with server actions or route handlers.
Use next/image, next/link. Metadata via generateMetadata().`,
    "react": `Framework: React (client-side SPA).
Functional components with hooks. State via useState/useReducer.
Side effects via useEffect. Context for shared state.
Follow component/hook naming conventions in existing codebase.`,
    "node": `Platform: Node.js.
Follow existing patterns in the repo. Use appropriate module system.`,
  };

  const guide = frameworkGuide[stack.framework] || frameworkGuide["node"];
  const depsContext = stack.keyDeps.length
    ? `\nAvailable dependencies: ${stack.keyDeps.join(", ")}. Use ONLY these — do NOT add new dependencies.`
    : "";
  const lintContext = stack.lintRules
    ? `\nLint rules active — follow them strictly. Key config:\n${stack.lintRules.slice(0, 400)}`
    : "";
  const conventionContext = stack.conventions
    ? `\nProject conventions: ${stack.conventions}`
    : "";

  return `You are an expert ${stack.language === "typescript" ? "TypeScript" : "JavaScript"} developer.
${guide}
Module system: ${stack.moduleSystem} (use ${stack.moduleSystem === "esm" ? "import/export" : "require/module.exports"}).
${depsContext}${lintContext}${conventionContext}

CRITICAL RULES:
- Output ONLY a JSON array. No markdown, no explanations, no code fences.
- Each entry: {"path":"file/path.ts","content":"COMPLETE file content","action":"create|modify"}
- For modified files: output the ENTIRE updated file content, not just the diff.
- Match existing code style exactly (indentation, quotes, semicolons, naming).
- Include proper types and error handling.
- Never import packages not in the dependency list.
- Preserve all existing functionality when modifying files.`;
}
// ── File Reading ──

async function readTargetFiles(
  owner: string, repo: string, paths: string[], branch?: string,
): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const p of paths.slice(0, 8)) {
    try {
      const file = await githubTool.getFile(owner, repo, p, branch) as any;
      if (file?.content) files.set(p, String(file.content).slice(0, 2500));
    } catch { /* file may not exist yet */ }
  }
  return files;
}

/** Call LLM with smart routing for code generation */
async function callCodeLLM(system: string, user: string): Promise<string> {
  const rec = recommendProvider();

  if (rec.delayMs > 0) {
    console.log(`[coding-agent] waiting ${Math.ceil(rec.delayMs / 1000)}s for ${rec.provider} — ${rec.reason}`);
    await new Promise((r) => setTimeout(r, rec.delayMs));
  }

  console.log(`[coding-agent] smart-route → ${rec.provider} (${rec.reason})`);

  const providers: ProviderName[] = [rec.provider];
  if (rec.provider !== "openrouter" && config.useOpenRouter && isProviderAvailable("openrouter")) providers.push("openrouter");
  if (rec.provider !== "bedrock" && config.useBedrock && isProviderAvailable("bedrock")) providers.push("bedrock");
  if (rec.provider !== "ollama") providers.push("ollama");

  for (const provider of providers) {
    try {
      switch (provider) {
        case "openrouter":
          if (!isProviderAvailable("openrouter")) continue;
          return await callOpenRouter(system, user, { temp: 0.1, maxTokens: 4096 });
        case "bedrock":
          if (!isProviderAvailable("bedrock")) continue;
          return await callBedrock(system, user, { temp: 0.1, maxTokens: 4096 });
        case "ollama": {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 300_000);
          try {
            const res = await fetch(`${config.ollamaHost}/api/chat`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              signal: controller.signal,
              body: JSON.stringify({
                model: config.codeModel,
                messages: [
                  { role: "system", content: system },
                  { role: "user", content: user },
                ],
                stream: false,
                options: { temperature: 0.1, num_ctx: 3072, num_gpu: Number(process.env.OLLAMA_NUM_GPU ?? 28) },
              }),
            });
            clearTimeout(timeout);
            if (!res.ok) throw new Error(`Ollama ${res.status}`);
            const data = (await res.json()) as any;
            return data.message?.content ?? "";
          } finally { clearTimeout(timeout); }
        }
      }
    } catch (err) {
      console.warn(`[coding-agent] ${provider} failed, trying next: ${(err as Error).message.slice(0, 100)}`);
    }
  }

  throw new Error("All LLM providers exhausted for code generation");
}
// ── Code Generation ──

async function generateCode(
  objective: string, existingFiles: Map<string, string>, repoContext: string, stack: RepoStack,
): Promise<Array<{ path: string; content: string; action: "create" | "modify" }>> {
  const fileContext = Array.from(existingFiles.entries())
    .map(([path, content]) => `=== ${path} ===\n${content}`)
    .join("\n\n");

  const system = buildSystemPrompt(stack);

  // Include package.json and tsconfig in the user prompt for direct reference
  let configContext = "";
  if (stack.packageJson) configContext += `\n=== package.json ===\n${stack.packageJson}\n`;
  if (stack.tsConfig) configContext += `\n=== tsconfig.json ===\n${stack.tsConfig}\n`;

  const user = `OBJECTIVE: ${objective}

EXISTING FILES:
${fileContext || "No existing files (creating new)"}

PROJECT STRUCTURE:
${repoContext.slice(0, 800)}
${configContext}
Return JSON array of file changes:`;

  try {
    const raw = await callCodeLLM(system, user);
    const arrayMatch = raw.match(/\[[\s\S]*\]/);
    if (!arrayMatch) return [];

    const stripped = arrayMatch[0]
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ');

    let changes: any[];
    try {
      changes = JSON.parse(stripped) as any[];
    } catch (firstErr) {
      console.warn(`[coding-agent] JSON parse failed: ${(firstErr as Error).message}`);
      console.warn(`[coding-agent] Raw LLM (first 300 chars): ${JSON.stringify(stripped.slice(0, 300))}`);
      console.warn('[coding-agent] JSON parse retry with string-aware sanitization');
      let fixed = '';
      let inString = false;
      let escaped = false;
      for (let i = 0; i < stripped.length; i++) {
        const ch = stripped[i];
        if (escaped) { escaped = false; fixed += ch; continue; }
        if (ch === '\\' && inString) { escaped = true; fixed += ch; continue; }
        if (ch === '"') { inString = !inString; fixed += ch; continue; }
        if (inString && (ch === '\n' || ch === '\r' || ch === '\t')) {
          fixed += ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : '\\t';
          continue;
        }
        if (inString && ch === '`') { fixed += "'"; continue; }
        fixed += ch;
      }
      try {
        changes = JSON.parse(fixed) as any[];
      } catch {
        console.warn('[coding-agent] JSON parse failed, trying markdown extraction');
        const mdBlocks = stripped.matchAll(/```(?:\w+)?\n([\s\S]*?)```/g);
        const extracted: any[] = [];
        for (const m of mdBlocks) {
          extracted.push({ path: 'extracted.ts', content: m[1].trim(), action: 'create' });
        }
        changes = extracted.length ? extracted : JSON.parse(stripped);
      }
    }

    return changes
      .filter((c: any) => c.path && c.content)
      .map((c: any) => ({
        path: String(c.path),
        content: String(c.content),
        action: c.action === "create" ? "create" as const : "modify" as const,
      }));
  } catch (err) {
    console.error(`[coding-agent] Code generation failed: ${(err as Error).message}`);
    return [];
  }
}
// ── Preflight: Dedup + Relevance Check ──

type PreflightResult = {
  proceed: boolean;
  reason?: string;
};

async function preflightCheck(
  task: GeneratedTask,
  owner: string,
  repo: string,
  existingFiles: Map<string, string>,
): Promise<PreflightResult> {
  // 1. PR deduplication — skip if similar PR already open
  try {
    const openPRs = await githubTool.listOpenPRs(owner, repo);
    const taskWords = task.title.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    for (const pr of openPRs) {
      const prText = `${pr.title} ${pr.body}`.toLowerCase();
      const overlap = taskWords.filter((w) => prText.includes(w)).length;
      if (overlap >= Math.max(2, taskWords.length * 0.5)) {
        return { proceed: false, reason: `Similar PR already open: #${pr.number} "${pr.title}"` };
      }
      // Also check branch name overlap
      if (pr.head.includes(task.id)) {
        return { proceed: false, reason: `Branch for task ${task.id} already exists: ${pr.head}` };
      }
    }
  } catch { /* non-blocking — proceed if API fails */ }

  // 2. Task relevance — verify target files exist or can be created meaningfully
  if (task.contextPaths.length > 0 && existingFiles.size === 0) {
    // All context paths were unreadable — task may reference non-existent files
    // Only block if task is "modify" oriented (not create-new)
    const objectiveLower = task.objective.toLowerCase();
    if (objectiveLower.includes("modify") || objectiveLower.includes("update") ||
        objectiveLower.includes("fix") || objectiveLower.includes("refactor")) {
      return { proceed: false, reason: `Target files don't exist: ${task.contextPaths.join(", ")}` };
    }
  }

  // 3. Objective specificity — reject vague objectives that won't produce useful code
  if (task.objective.length < 30) {
    return { proceed: false, reason: `Objective too vague (${task.objective.length} chars): "${task.objective}"` };
  }
  const vaguePatterns = [
    /^implement\s+\w+$/i,
    /^add\s+\w+$/i,
    /^create\s+\w+$/i,
    /^set\s*up\s+\w+$/i,
    /^improve\s+\w+$/i,
  ];
  if (vaguePatterns.some((p) => p.test(task.objective.trim()))) {
    return { proceed: false, reason: `Objective too generic: "${task.objective}"` };
  }

  return { proceed: true };
}

// ── Validation Gate ──

type ValidationResult = {
  pass: boolean;
  issues: string[];
  suggestions: string[];
};

async function validateCodeChanges(
  changes: Array<{ path: string; content: string; action: "create" | "modify" }>,
  objective: string,
  stack: RepoStack,
): Promise<ValidationResult> {
  const issues: string[] = [];
  const suggestions: string[] = [];

  // 1. Structural validation (fast, no LLM)
  for (const change of changes) {
    if (!change.content.trim()) {
      issues.push(`${change.path}: empty file content`);
      continue;
    }
    if (change.path.endsWith(".ts") || change.path.endsWith(".tsx")) {
      const braceOpen = (change.content.match(/\{/g) || []).length;
      const braceClose = (change.content.match(/\}/g) || []).length;
      if (Math.abs(braceOpen - braceClose) > 2) {
        issues.push(`${change.path}: mismatched braces (open=${braceOpen}, close=${braceClose})`);
      }
      const anyCount = (change.content.match(/:\s*any\b/g) || []).length;
      if (anyCount > 3) {
        suggestions.push(`${change.path}: ${anyCount} uses of 'any' type`);
      }
    }
    if (stack.moduleSystem === "esm" && change.content.includes("require(")) {
      issues.push(`${change.path}: uses require() but repo uses ESM`);
    }
    if (stack.moduleSystem === "commonjs" && change.content.includes("import ") && change.content.includes(" from ")) {
      issues.push(`${change.path}: uses ESM imports but repo uses CommonJS`);
    }
    const importMatches = change.content.matchAll(/(?:import|require)\s*\(?['"]([^./][^'"]*)['"]\)?/g);
    for (const m of importMatches) {
      const pkg = m[1].startsWith("@") ? m[1].split("/").slice(0, 2).join("/") : m[1].split("/")[0];
      if (stack.keyDeps.length > 0 && !stack.keyDeps.includes(pkg) && !isNodeBuiltin(pkg)) {
        issues.push(`${change.path}: imports '${pkg}' not in dependencies`);
      }
    }
  }

  // 2. LLM self-review (only if structural checks pass)
  if (issues.length === 0) {
    try {
      const fileSummary = changes.map((c) =>
        `=== ${c.path} (${c.action}) ===\n${c.content.slice(0, 1500)}`
      ).join("\n\n");

      const reviewPrompt = `Review this code for correctness, security, and completeness.
Objective: ${objective}
Stack: ${stack.framework}/${stack.language}/${stack.buildTool}

${fileSummary}

Respond with ONLY a JSON object:
{"pass":true|false,"issues":["issue1"],"suggestions":["suggestion1"]}`;

      const raw = await callCodeLLM(
        "You are a senior code reviewer. Be concise. Focus on bugs, security, missing error handling.",
        reviewPrompt,
      );
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const review = JSON.parse(jsonMatch[0]) as { pass?: boolean; issues?: string[]; suggestions?: string[] };
        if (review.issues?.length) issues.push(...review.issues);
        if (review.suggestions?.length) suggestions.push(...review.suggestions);
        if (review.pass === false && issues.length === 0) {
          issues.push("LLM reviewer flagged code as not passing");
        }
      }
    } catch (err) {
      console.warn(`[coding-agent] LLM review failed (non-blocking): ${(err as Error).message.slice(0, 100)}`);
    }
  }

  // 3. Meaningful diff check — reject trivial/cosmetic-only changes
  if (issues.length === 0) {
    const totalContentLength = changes.reduce((s, c) => s + c.content.length, 0);
    if (totalContentLength < 50) {
      issues.push(`Generated code too short (${totalContentLength} chars total) — likely not meaningful`);
    }
    // Check for changes that are just comments/whitespace
    for (const change of changes) {
      const nonCommentLines = change.content.split("\n")
        .filter((l) => l.trim() && !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"));
      if (nonCommentLines.length < 3 && change.action === "modify") {
        issues.push(`${change.path}: modification has only ${nonCommentLines.length} non-comment lines — likely not meaningful`);
      }
    }
  }

  const pass = issues.length === 0;
  if (!pass) console.warn(`[coding-agent] Validation FAILED: ${issues.join("; ")}`);
  else console.log(`[coding-agent] Validation passed (${suggestions.length} suggestions)`);
  return { pass, issues, suggestions };
}

function isNodeBuiltin(pkg: string): boolean {
  const builtins = new Set([
    "fs", "path", "os", "http", "https", "url", "util", "crypto", "stream",
    "events", "child_process", "buffer", "querystring", "zlib", "net", "tls",
    "dns", "readline", "assert", "cluster", "worker_threads", "perf_hooks",
    "node:fs", "node:path", "node:os", "node:http", "node:https", "node:url",
    "node:util", "node:crypto", "node:stream", "node:events", "node:child_process",
    "node:buffer", "node:querystring", "node:zlib", "node:net", "node:tls",
    "node:dns", "node:readline", "node:assert", "node:worker_threads",
  ]);
  return builtins.has(pkg);
}

// ── Copilot Review Loop ──

type ReviewOutcome = {
  status: "approved" | "changes_requested" | "no_review" | "error";
  comments: Array<{ path: string; line: number | null; body: string }>;
  fixesApplied: number;
};

async function handleCopilotReview(
  owner: string, repo: string, prNumber: number,
  branchName: string, stack: RepoStack, maxAttempts = 2,
): Promise<ReviewOutcome> {
  console.log(`[coding-agent] Waiting for Copilot review on PR #${prNumber}...`);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const waitMs = attempt === 0 ? 60_000 : 90_000;
    console.log(`[coding-agent] Poll attempt ${attempt + 1}/${maxAttempts}, waiting ${waitMs / 1000}s...`);
    await new Promise((r) => setTimeout(r, waitMs));

    try {
      const status = await githubTool.getPRStatus(owner, repo, prNumber);

      if (status.reviewDecision === "APPROVED") {
        console.log(`[coding-agent] PR #${prNumber} APPROVED`);
        return { status: "approved", comments: [], fixesApplied: 0 };
      }

      if (status.reviewDecision === "CHANGES_REQUESTED") {
        console.log(`[coding-agent] PR #${prNumber} CHANGES_REQUESTED`);
        const comments = await githubTool.getReviewComments(owner, repo, prNumber);
        const actionable = comments
          .filter((c) => c.body && !c.body.toLowerCase().includes("nit") && !c.inReplyToId)
          .map((c) => ({ path: c.path, line: c.line, body: c.body }));

        if (actionable.length === 0) {
          return { status: "approved", comments: [], fixesApplied: 0 };
        }

        console.log(`[coding-agent] Fixing ${actionable.length} review comments...`);
        const fixesApplied = await applyReviewFixes(owner, repo, branchName, actionable, stack);

        if (fixesApplied > 0) {
          try { await githubTool.requestReview(owner, repo, prNumber); } catch { /* best-effort */ }
        }

        return { status: "changes_requested", comments: actionable, fixesApplied };
      }

      if (attempt > 0) {
        try { await githubTool.requestReview(owner, repo, prNumber); } catch { /* nudge */ }
      }
    } catch (err) {
      console.warn(`[coding-agent] Review poll error: ${(err as Error).message.slice(0, 100)}`);
    }
  }

  return { status: "no_review", comments: [], fixesApplied: 0 };
}

async function applyReviewFixes(
  owner: string, repo: string, branch: string,
  comments: Array<{ path: string; line: number | null; body: string }>,
  stack: RepoStack,
): Promise<number> {
  const byFile = new Map<string, Array<{ line: number | null; body: string }>>();
  for (const c of comments) {
    const arr = byFile.get(c.path) || [];
    arr.push({ line: c.line, body: c.body });
    byFile.set(c.path, arr);
  }

  let fixCount = 0;
  for (const [filePath, fileComments] of byFile) {
    try {
      const existing = await githubTool.getFile(owner, repo, filePath, branch) as any;
      if (!existing?.content) continue;

      const commentSummary = fileComments
        .map((c) => `Line ${c.line ?? "?"}: ${c.body}`).join("\n");

      const fixPrompt = `Fix review comments on this file.

FILE: ${filePath}
CURRENT CONTENT:
${String(existing.content).slice(0, 3000)}

REVIEW COMMENTS:
${commentSummary}

Return ONLY the complete updated file content. No JSON, no markdown fences.`;

      const fixedContent = await callCodeLLM(
        buildSystemPrompt(stack) + "\nFix review comments. Return ONLY complete file content.",
        fixPrompt,
      );

      if (fixedContent && fixedContent.trim().length > 50) {
        let clean = fixedContent.trim();
        if (clean.startsWith("```")) {
          clean = clean.replace(/^```\w*\n/, "").replace(/\n```\s*$/, "");
        }
        await githubTool.commitFile(
          owner, repo, branch, filePath, clean,
          `fix: address review comments on ${filePath}`, existing.sha,
        );
        fixCount++;
      }
    } catch (err) {
      console.warn(`[coding-agent] Fix failed for ${filePath}: ${(err as Error).message.slice(0, 100)}`);
    }
  }
  return fixCount;
}

// ── Main Entry Point ──

/** Execute a code task: detect stack -> read files -> generate code -> validate -> branch -> commit -> PR -> review */
export async function executeCodeTask(
  task: GeneratedTask,
  owner: string,
  repo: string,
  opts?: { dryRun?: boolean },
): Promise<CodingResult> {
  const dryRun = opts?.dryRun ?? true;
  const branchName = `auto/${task.id}-${Date.now().toString(36)}`;

  console.log(`[coding-agent] Task: ${task.title}`);
  console.log(`[coding-agent] Target: ${owner}/${repo}, branch: ${branchName}`);
  broadcast("coding-agent:start", { taskId: task.id, title: task.title, repo: `${owner}/${repo}` });

  try {
    // 0. Detect repo stack (cached per repo)
    const stack = await detectRepoStack(owner, repo);

    // 1. Read existing target files
    const existingFiles = await readTargetFiles(owner, repo, task.contextPaths);
    console.log(`[coding-agent] Read ${existingFiles.size} existing files`);

    // 1b. Preflight check — dedup, relevance, specificity
    const preflight = await preflightCheck(task, owner, repo, existingFiles);
    if (!preflight.proceed) {
      console.log(`[coding-agent] Preflight REJECTED: ${preflight.reason}`);
      broadcast("coding-agent:preflight-rejected", { taskId: task.id, reason: preflight.reason });
      return { taskId: task.id, success: false, filesChanged: [], error: `Preflight: ${preflight.reason}` };
    }

    // 2. Get repo tree for broader context
    let repoStructure = "";
    try {
      const tree = await githubTool.getTree(owner, repo) as any;
      if (tree?.tree) {
        repoStructure = (tree.tree as any[])
          .map((t: any) => t.path)
          .filter((p: string) => !p.includes("node_modules") && !p.includes("dist/"))
          .slice(0, 50).join("\n");
      }
    } catch { /* silent */ }

    // 3. Generate code changes via LLM (with stack context)
    console.log(`[coding-agent] Generating code (stack: ${stack.framework}/${stack.language})...`);
    let changes = await generateCode(task.objective, existingFiles, repoStructure, stack);
    if (!changes.length) {
      console.log(`[coding-agent] Empty response, retrying once...`);
      await new Promise((r) => setTimeout(r, 3000));
      changes = await generateCode(task.objective, existingFiles, repoStructure, stack);
    }
    if (!changes.length) {
      return { taskId: task.id, success: false, filesChanged: [], error: "LLM produced no code changes" };
    }
    console.log(`[coding-agent] Generated ${changes.length} file changes`);
    broadcast("coding-agent:generated", { taskId: task.id, files: changes.map((c) => c.path) });

    // 3b. Validate generated code before committing
    console.log(`[coding-agent] Validating ${changes.length} file changes...`);
    const validation = await validateCodeChanges(changes, task.objective, stack);
    if (!validation.pass) {
      broadcast("coding-agent:validation-failed", { taskId: task.id, issues: validation.issues });
      return {
        taskId: task.id, success: false, filesChanged: [],
        error: `Validation failed: ${validation.issues.join("; ")}`,
      };
    }

    if (dryRun) {
      await memoryStore.add({
        title: `[DRY RUN] Code: ${task.title}`,
        details: `Stack: ${stack.framework}/${stack.language}/${stack.buildTool}\n` +
          `Validation: PASSED (${validation.suggestions.length} suggestions)\n` +
          changes.map((c) => `${c.action} ${c.path} (${c.content.length} chars)`).join("\n"),
        tags: ["coding-agent", "dry-run", task.id],
        source: "coding-agent",
      });
      return { taskId: task.id, success: true, branch: branchName, filesChanged: changes.map((c) => c.path) };
    }

    // 4. Create branch
    console.log(`[coding-agent] Creating branch: ${branchName}`);
    await githubTool.createBranch(owner, repo, branchName);

    // 5. Commit each file
    for (const change of changes) {
      console.log(`[coding-agent] Committing: ${change.path}`);
      let sha: string | undefined;
      if (change.action === "modify") {
        try {
          const existing = await githubTool.getFile(owner, repo, change.path, branchName) as any;
          sha = existing?.sha;
        } catch { /* new file */ }
      }
      await githubTool.commitFile(
        owner, repo, branchName, change.path, change.content,
        `auto: ${task.title} — ${change.action} ${change.path}`, sha,
      );
    }

    // 6. Create PR
    console.log(`[coding-agent] Creating PR...`);
    const prBody = [
      `## Auto-generated by Coding Agent`,
      `**Task:** ${task.title}`,
      `**Objective:** ${task.objective}`,
      `**Stack:** ${stack.framework} / ${stack.language} / ${stack.buildTool} (${stack.moduleSystem})`,
      `**Reasoning:** ${task.reasoning}`,
      `**Validation:** Passed (${validation.suggestions.length} suggestions)`,
      `### Files Changed`,
      ...changes.map((c) => `- \`${c.path}\` (${c.action})`),
      ...(validation.suggestions.length > 0 ? [
        `### Suggestions (non-blocking)`,
        ...validation.suggestions.map((s) => `- ${s}`),
      ] : []),
      `---`,
      `*Generated by local-devops-ai coding agent*`,
    ].join("\n");

    const pr = await githubTool.createPR(owner, repo, branchName, `auto: ${task.title}`, prBody);
    const prUrl = pr.url ?? "";
    console.log(`[coding-agent] PR created: ${prUrl}`);
    broadcast("coding-agent:pr", { taskId: task.id, prUrl, prNumber: pr.number });

    // 7. Request Copilot review + tag @claude for Claude Max review
    try { await githubTool.requestReview(owner, repo, pr.number); } catch { /* silent */ }
    try {
      await githubTool.addPRComment(owner, repo, pr.number,
        `@claude Please review this PR for correctness, security issues, and adherence to project conventions.`);
    } catch { /* silent */ }

    // 8. Enable auto-merge (squash) — requires repo setting enabled
    try { await githubTool.enableAutoMerge(owner, repo, pr.number); } catch { /* silent */ }

    // 9. Poll for Copilot review, address feedback if needed
    const reviewOutcome = await handleCopilotReview(owner, repo, pr.number, branchName, stack);
    console.log(`[coding-agent] Review outcome: ${reviewOutcome.status} (${reviewOutcome.fixesApplied} fixes applied)`);
    broadcast("coding-agent:review", {
      taskId: task.id, prNumber: pr.number,
      status: reviewOutcome.status, fixesApplied: reviewOutcome.fixesApplied,
    });

    // 10. Auto-merge if approved and auto-merge didn't trigger
    if (reviewOutcome.status === "approved") {
      try {
        const prStatus = await githubTool.getPRStatus(owner, repo, pr.number);
        if (prStatus.state === "open" && prStatus.mergeable) {
          console.log(`[coding-agent] Squash-merging PR #${pr.number}...`);
          await githubTool.mergePR(owner, repo, pr.number, "squash");
          // Clean up branch
          try { await githubTool.deleteBranch(owner, repo, branchName); } catch { /* silent */ }
          console.log(`[coding-agent] PR #${pr.number} merged and branch cleaned up`);
          broadcast("coding-agent:merged", { taskId: task.id, prNumber: pr.number });
        }
      } catch (err) {
        console.warn(`[coding-agent] Auto-merge failed: ${(err as Error).message.slice(0, 100)}`);
      }
    }

    // 11. Store in memory
    await memoryStore.add({
      title: `Code PR: ${task.title}`,
      details: `Branch: ${branchName}\nPR: ${prUrl}\nStack: ${stack.framework}/${stack.language}\n` +
        `Review: ${reviewOutcome.status} (${reviewOutcome.fixesApplied} fixes)\n` +
        `Files: ${changes.map((c) => c.path).join(", ")}`,
      tags: ["coding-agent", "pr", task.id],
      source: "coding-agent",
    });

    return { taskId: task.id, success: true, branch: branchName, prUrl, filesChanged: changes.map((c) => c.path) };
  } catch (err) {
    const msg = (err as Error).message;
    console.error(`[coding-agent] Failed: ${msg}`);
    broadcast("coding-agent:error", { taskId: task.id, error: msg });
    return { taskId: task.id, success: false, filesChanged: [], error: msg };
  }
}
