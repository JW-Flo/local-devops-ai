/**
 * Coding Agent — reads repo files, generates code, creates branches + PRs.
 * Constraint-aware: works within 8GB VRAM / 3072 num_ctx budget.
 * Single-shot generation (8b model can't maintain multi-turn coherence).
 * 
 * Provider chain: OpenRouter (free) → Bedrock → Ollama (CPU fallback)
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

async function readTargetFiles(
  owner: string, repo: string, paths: string[], branch?: string,
): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const p of paths.slice(0, 5)) {
    try {
      const file = await githubTool.getFile(owner, repo, p, branch) as any;
      if (file?.content) files.set(p, String(file.content).slice(0, 1500));
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

async function generateCode(
  objective: string, existingFiles: Map<string, string>, repoContext: string,
): Promise<Array<{ path: string; content: string; action: "create" | "modify" }>> {
  const fileContext = Array.from(existingFiles.entries())
    .map(([path, content]) => `=== ${path} ===\n${content}`)
    .join("\n\n");

  const system = `You are an expert TypeScript/JavaScript developer.
Generate complete, working code changes. Output ONLY a JSON array.
Each entry: {"path":"file/path.ts","content":"COMPLETE file content","action":"create|modify"}
For modified files: output the ENTIRE updated file. Follow existing style. Include types and error handling.
No explanations, no markdown — JSON array only.`;

  const user = `OBJECTIVE: ${objective}

EXISTING FILES:
${fileContext || "No existing files (creating new)"}

PROJECT STRUCTURE:
${repoContext.slice(0, 400)}

Return JSON array of file changes:`;

  try {
    const raw = await callCodeLLM(system, user);
    const arrayMatch = raw.match(/\[[\s\S]*\]/);
    if (!arrayMatch) return [];
    const changes = JSON.parse(arrayMatch[0]) as any[];
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

/** Execute a code task: read files -> generate code -> branch -> commit -> PR */
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
    // 1. Read existing target files
    const existingFiles = await readTargetFiles(owner, repo, task.contextPaths);
    console.log(`[coding-agent] Read ${existingFiles.size} existing files`);

    // 2. Get repo tree for broader context
    let repoStructure = "";
    try {
      const tree = await githubTool.getTree(owner, repo) as any;
      if (tree?.tree) {
        repoStructure = (tree.tree as any[])
          .map((t: any) => t.path)
          .filter((p: string) => !p.includes("node_modules") && !p.includes("dist/"))
          .slice(0, 30).join("\n");
      }
    } catch { /* silent */ }

    // 3. Generate code changes via LLM
    console.log(`[coding-agent] Generating code...`);
    const changes = await generateCode(task.objective, existingFiles, repoStructure);
    if (!changes.length) {
      return { taskId: task.id, success: false, filesChanged: [], error: "LLM produced no code changes" };
    }
    console.log(`[coding-agent] Generated ${changes.length} file changes`);
    broadcast("coding-agent:generated", { taskId: task.id, files: changes.map((c) => c.path) });

    if (dryRun) {
      await memoryStore.add({
        title: `[DRY RUN] Code: ${task.title}`,
        details: changes.map((c) => `${c.action} ${c.path} (${c.content.length} chars)`).join("\n"),
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
      `**Reasoning:** ${task.reasoning}`,
      `### Files Changed`,
      ...changes.map((c) => `- \`${c.path}\` (${c.action})`),
      `---`,
      `*Generated by local-devops-ai coding agent*`,
    ].join("\n");

    const pr = await githubTool.createPR(owner, repo, branchName, `auto: ${task.title}`, prBody);

    // 7. Request Copilot review (best-effort)
    try { await githubTool.requestReview(owner, repo, pr.number); } catch { /* silent */ }

    const prUrl = pr.url ?? "";
    console.log(`[coding-agent] PR created: ${prUrl}`);
    broadcast("coding-agent:pr", { taskId: task.id, prUrl, prNumber: pr.number });

    // 8. Store in memory for future context
    await memoryStore.add({
      title: `Code PR: ${task.title}`,
      details: `Branch: ${branchName}\nPR: ${prUrl}\nFiles: ${changes.map((c) => c.path).join(", ")}`,
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
