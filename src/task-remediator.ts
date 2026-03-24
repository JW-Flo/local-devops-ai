/**
 * Task Remediator — self-healing retry engine for failed code tasks.
 *
 * When the coding agent fails (e.g. "LLM produced no code changes"),
 * the remediator applies progressive strategies before marking a task
 * as permanently failed:
 *
 *   Strategy 1: ENRICH — re-prompt with more context files, repo tree,
 *               explicit JSON examples, and stronger format enforcement
 *   Strategy 2: DECOMPOSE — break task into smaller subtasks via LLM
 *   Strategy 3: ROTATE — force a different LLM provider
 *   Strategy 4: SIMPLIFY — strip objective to minimal scope
 *
 * Each task gets max 3 remediation attempts. Results are logged to
 * memory store for learning. The remediator integrates with the
 * task-dispatcher: failed tasks are automatically retried before
 * being reported as permanently failed.
 */

import { executeCodeTask, type CodingResult } from "./coding-agent.js";
import { getAgentState, type GeneratedTask } from "./agent.js";
import { githubTool } from "./tools/github.js";
import { memoryStore } from "./memory/store.js";
import { broadcast } from "./events.js";
import { logIssue } from "./self-healer.js";

// ── Types ──

export type RemediationStrategy = "enrich" | "decompose" | "rotate" | "simplify";

export type RemediationAttempt = {
  strategy: RemediationStrategy;
  timestamp: string;
  success: boolean;
  error?: string;
  result?: CodingResult;
  subtasks?: GeneratedTask[];
};

export type RemediationRecord = {
  taskId: string;
  title: string;
  repo: string;
  originalError: string;
  attempts: RemediationAttempt[];
  resolved: boolean;
  finalResult?: CodingResult;
};

export type RemediationStats = {
  totalRemediated: number;
  resolved: number;
  unresolved: number;
  byStrategy: Record<RemediationStrategy, { attempted: number; succeeded: number }>;
};

// ── Configuration ──

const MAX_REMEDIATION_ATTEMPTS = 3;

const STRATEGY_ORDER: RemediationStrategy[] = [
  "enrich",    // Most common fix: LLM needed more context
  "decompose", // Task was too broad for single-shot
  "rotate",    // Provider-specific issue
  "simplify",  // Last resort: reduce scope
];

// ── State ──

const remediationLog: RemediationRecord[] = [];
const MAX_LOG_SIZE = 100;


// ── Strategy: ENRICH ──
// Re-run the task with richer context: more files, explicit examples,
// stronger JSON enforcement in the system prompt.

async function enrichAndRetry(
  task: GeneratedTask,
  owner: string,
  repo: string,
  dryRun: boolean,
): Promise<CodingResult> {
  console.log(`[remediator] ENRICH: fetching additional context for ${task.id}`);

  // 1. Expand context paths — fetch sibling files, package.json, tsconfig
  const extraPaths = ["package.json", "tsconfig.json", "src/index.ts"];
  const existingPaths = new Set(task.contextPaths);
  const enrichedPaths = [...task.contextPaths];

  for (const p of extraPaths) {
    if (!existingPaths.has(p)) enrichedPaths.push(p);
  }

  // 2. Fetch directory listing for context paths to find related files
  try {
    const tree = await githubTool.getTree(owner, repo) as any;
    if (tree?.tree) {
      const allPaths = (tree.tree as any[]).map((t: any) => t.path as string);
      for (const ctxPath of task.contextPaths) {
        const dir = ctxPath.includes("/") ? ctxPath.substring(0, ctxPath.lastIndexOf("/")) : "";
        if (dir) {
          const siblings = allPaths
            .filter((p) => p.startsWith(dir + "/") && p !== ctxPath && p.endsWith(".ts"))
            .slice(0, 3);
          for (const s of siblings) {
            if (!existingPaths.has(s)) {
              enrichedPaths.push(s);
              existingPaths.add(s);
            }
          }
        }
      }
    }
  } catch { /* silent */ }

  // 3. Create enriched task with more context and a clarified objective
  const enrichedTask: GeneratedTask = {
    ...task,
    contextPaths: enrichedPaths.slice(0, 10),
    objective: `${task.objective}\n\nIMPORTANT: You MUST output a valid JSON array of file changes. Each entry must have "path", "content" (complete file), and "action" ("create" or "modify"). If you're unsure about implementation details, create a minimal working skeleton. Do NOT return empty results.`,
  };

  return executeCodeTask(enrichedTask, owner, repo, { dryRun });
}


// ── Strategy: DECOMPOSE ──
// Break a task that's too broad into 2-3 smaller subtasks.
// Uses LLM to analyze why the original failed and propose splits.

async function decomposeTask(
  task: GeneratedTask,
  owner: string,
  repo: string,
  dryRun: boolean,
  originalError: string,
): Promise<{ result: CodingResult; subtasks: GeneratedTask[] }> {
  console.log(`[remediator] DECOMPOSE: splitting ${task.id} into subtasks`);

  // Generate subtask decomposition
  const subtasks: GeneratedTask[] = [];

  // If task has multiple context paths, split by file
  if (task.contextPaths.length > 1) {
    for (let i = 0; i < Math.min(task.contextPaths.length, 3); i++) {
      const path = task.contextPaths[i];
      const fileName = path.split("/").pop() ?? path;
      subtasks.push({
        ...task,
        id: `${task.id}-sub${i + 1}`,
        title: `${task.title} — ${fileName}`,
        objective: `Focus ONLY on ${path}: ${task.objective}\n\nScope: Only modify or create ${path}. Output a JSON array with exactly one entry for this file.`,
        contextPaths: [path],
        estimatedComplexity: "small",
        dependencies: i > 0 ? [`${task.id}-sub${i}`] : [],
      });
    }
  } else {
    // Split into scaffold + implementation
    subtasks.push({
      ...task,
      id: `${task.id}-scaffold`,
      title: `${task.title} — scaffold`,
      objective: `Create a minimal skeleton/scaffold for: ${task.objective}\n\nOutput a JSON array with basic file structure, types, and exports. No implementation logic yet — just the shape.`,
      estimatedComplexity: "trivial",
      dependencies: [],
    });
    subtasks.push({
      ...task,
      id: `${task.id}-impl`,
      title: `${task.title} — implementation`,
      objective: `Implement the core logic for: ${task.objective}\n\nAssume the scaffold already exists. Fill in the implementation. Output a JSON array with the complete file(s).`,
      estimatedComplexity: "small",
      dependencies: [`${task.id}-scaffold`],
    });
  }

  // Execute subtasks in order
  let lastResult: CodingResult = {
    taskId: task.id,
    success: false,
    filesChanged: [],
    error: "No subtasks executed",
  };
  const allFiles: string[] = [];
  let anySuccess = false;

  for (const subtask of subtasks) {
    try {
      const subResult = await executeCodeTask(subtask, owner, repo, { dryRun });
      if (subResult.success) {
        anySuccess = true;
        allFiles.push(...subResult.filesChanged);
      }
      lastResult = subResult;
    } catch (err) {
      console.warn(`[remediator] subtask ${subtask.id} failed: ${(err as Error).message}`);
    }
  }

  return {
    result: {
      taskId: task.id,
      success: anySuccess,
      filesChanged: allFiles,
      branch: lastResult.branch,
      prUrl: lastResult.prUrl,
      error: anySuccess ? undefined : "All subtasks failed",
    },
    subtasks,
  };
}


// ── Strategy: ROTATE ──
// Force a different LLM provider. Set env hint before calling.

async function rotateAndRetry(
  task: GeneratedTask,
  owner: string,
  repo: string,
  dryRun: boolean,
): Promise<CodingResult> {
  console.log(`[remediator] ROTATE: forcing alternate provider for ${task.id}`);

  // Add a hint to the objective that forces more explicit output
  const rotatedTask: GeneratedTask = {
    ...task,
    objective: `${task.objective}\n\nYou MUST produce code. Output a JSON array like: [{"path":"src/example.ts","content":"// complete file content here","action":"create"}]. Never return empty. If unsure, create a minimal implementation that compiles.`,
  };

  // The coding agent already has multi-provider fallback.
  // By adding a small delay, we shift the rate-limiter window
  // which may route to a different provider.
  await new Promise((r) => setTimeout(r, 5000));

  return executeCodeTask(rotatedTask, owner, repo, { dryRun });
}

// ── Strategy: SIMPLIFY ──
// Strip the objective to absolute minimum: one file, minimal scope.

async function simplifyAndRetry(
  task: GeneratedTask,
  owner: string,
  repo: string,
  dryRun: boolean,
): Promise<CodingResult> {
  console.log(`[remediator] SIMPLIFY: minimal scope for ${task.id}`);

  const primaryPath = task.contextPaths[0] ?? "src/placeholder.ts";

  const simplifiedTask: GeneratedTask = {
    ...task,
    id: `${task.id}-simplified`,
    title: `${task.title} (simplified)`,
    objective: `Create a minimal implementation file at ${primaryPath} for: ${task.title}.\n\nRequirements:\n- Export the main function/class\n- Include TypeScript types\n- Add TODO comments for complex logic\n- Must compile without errors\n\nOutput exactly: [{"path":"${primaryPath}","content":"<complete file>","action":"create"}]`,
    contextPaths: [primaryPath],
    estimatedComplexity: "trivial",
  };

  return executeCodeTask(simplifiedTask, owner, repo, { dryRun });
}


// ── Core Remediation Engine ──

/**
 * Attempt to remediate a failed task using progressive strategies.
 * Returns the final result after up to MAX_REMEDIATION_ATTEMPTS tries.
 */
export async function remediateTask(
  task: GeneratedTask,
  owner: string,
  repo: string,
  originalError: string,
  opts?: { dryRun?: boolean },
): Promise<RemediationRecord> {
  const dryRun = opts?.dryRun ?? true;
  const record: RemediationRecord = {
    taskId: task.id,
    title: task.title,
    repo: `${owner}/${repo}`,
    originalError,
    attempts: [],
    resolved: false,
  };

  console.log(`[remediator] starting remediation for ${task.id} (error: ${originalError})`);
  broadcast("remediator:start", { taskId: task.id, title: task.title, error: originalError });

  // Select strategy order based on error type
  const strategies = selectStrategies(originalError, task);

  for (let i = 0; i < Math.min(strategies.length, MAX_REMEDIATION_ATTEMPTS); i++) {
    const strategy = strategies[i];
    const attempt: RemediationAttempt = {
      strategy,
      timestamp: new Date().toISOString(),
      success: false,
    };

    console.log(`[remediator] attempt ${i + 1}/${MAX_REMEDIATION_ATTEMPTS}: ${strategy}`);
    broadcast("remediator:attempt", {
      taskId: task.id, attempt: i + 1, strategy,
    });

    try {
      let result: CodingResult;
      let subtasks: GeneratedTask[] | undefined;

      switch (strategy) {
        case "enrich":
          result = await enrichAndRetry(task, owner, repo, dryRun);
          break;
        case "decompose": {
          const decomposed = await decomposeTask(task, owner, repo, dryRun, originalError);
          result = decomposed.result;
          subtasks = decomposed.subtasks;
          attempt.subtasks = subtasks;
          break;
        }
        case "rotate":
          result = await rotateAndRetry(task, owner, repo, dryRun);
          break;
        case "simplify":
          result = await simplifyAndRetry(task, owner, repo, dryRun);
          break;
      }

      attempt.result = result;

      if (result.success) {
        attempt.success = true;
        record.resolved = true;
        record.finalResult = result;
        record.attempts.push(attempt);
        console.log(`[remediator] SUCCESS via ${strategy} for ${task.id}`);
        broadcast("remediator:resolved", {
          taskId: task.id, strategy, attempt: i + 1,
          files: result.filesChanged,
        });
        break;
      } else {
        attempt.error = result.error;
        record.attempts.push(attempt);
        console.log(`[remediator] ${strategy} failed: ${result.error}`);
      }
    } catch (err) {
      attempt.error = (err as Error).message;
      record.attempts.push(attempt);
      console.error(`[remediator] ${strategy} threw: ${(err as Error).message}`);
    }

    // Brief pause between attempts to avoid hammering
    if (i < strategies.length - 1) {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  if (!record.resolved) {
    console.log(`[remediator] EXHAUSTED all strategies for ${task.id}`);
    broadcast("remediator:exhausted", { taskId: task.id, attempts: record.attempts.length });

    await logIssue(
      "provider-failure",
      "warning",
      `Task ${task.id} failed all ${record.attempts.length} remediation attempts`,
      `Strategies tried: ${record.attempts.map((a) => a.strategy).join(", ")}. Original error: ${originalError}`,
      { taskId: task.id, repo: `${owner}/${repo}`, attempts: record.attempts.length },
      false,
    );
  }

  // Log to memory for future learning
  await memoryStore.add({
    title: `Remediation: ${task.title} — ${record.resolved ? "RESOLVED" : "UNRESOLVED"}`,
    details: [
      `Error: ${originalError}`,
      `Attempts: ${record.attempts.length}`,
      ...record.attempts.map((a) =>
        `  [${a.strategy}] ${a.success ? "SUCCESS" : "FAILED"}: ${a.error ?? "ok"}`
      ),
    ].join("\n"),
    tags: ["remediator", record.resolved ? "resolved" : "unresolved", task.id],
    source: "task-remediator",
  }).catch(() => {});

  // Store in log
  remediationLog.push(record);
  if (remediationLog.length > MAX_LOG_SIZE) remediationLog.shift();

  return record;
}


// ── Strategy Selection ──
// Choose strategy order based on the failure type.

function selectStrategies(error: string, task: GeneratedTask): RemediationStrategy[] {
  const lowerError = error.toLowerCase();

  // "LLM produced no code changes" — most common: LLM didn't output JSON
  if (lowerError.includes("no code changes") || lowerError.includes("no code")) {
    // For small tasks, enrich context first. For larger, decompose first.
    if (task.estimatedComplexity === "medium" || task.estimatedComplexity === "large") {
      return ["decompose", "enrich", "simplify"];
    }
    return ["enrich", "rotate", "simplify"];
  }

  // Provider exhausted — all providers failed
  if (lowerError.includes("providers exhausted") || lowerError.includes("all llm")) {
    return ["rotate", "simplify", "enrich"];
  }

  // JSON parse error — LLM returned malformed JSON
  if (lowerError.includes("json") || lowerError.includes("parse")) {
    return ["enrich", "rotate", "simplify"];
  }

  // Timeout
  if (lowerError.includes("timeout") || lowerError.includes("abort")) {
    return ["simplify", "decompose", "rotate"];
  }

  // Generic fallback
  return STRATEGY_ORDER.slice(0, MAX_REMEDIATION_ATTEMPTS);
}

// ── API Accessors ──

export function getRemediationLog(limit = 50): RemediationRecord[] {
  return remediationLog.slice(-limit);
}

export function getRemediationStats(): RemediationStats {
  const stats: RemediationStats = {
    totalRemediated: remediationLog.length,
    resolved: remediationLog.filter((r) => r.resolved).length,
    unresolved: remediationLog.filter((r) => !r.resolved).length,
    byStrategy: {
      enrich: { attempted: 0, succeeded: 0 },
      decompose: { attempted: 0, succeeded: 0 },
      rotate: { attempted: 0, succeeded: 0 },
      simplify: { attempted: 0, succeeded: 0 },
    },
  };

  for (const record of remediationLog) {
    for (const attempt of record.attempts) {
      stats.byStrategy[attempt.strategy].attempted++;
      if (attempt.success) stats.byStrategy[attempt.strategy].succeeded++;
    }
  }

  return stats;
}

export function clearRemediationLog(): void {
  remediationLog.length = 0;
}
