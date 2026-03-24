/**
 * Task Dispatcher — connects agent planning to execution.
 *
 * This is the missing link: runAgent() generates tasks but never executes them.
 * The dispatcher:
 *   1. Takes generated tasks from the agent state
 *   2. Filters for executable code tasks (vs plan/review/diagnose)
 *   3. Respects dependency ordering (topological sort)
 *   4. Dispatches to executeCodeTask() with rate-aware pacing
 *   5. Tracks results and logs to memory store
 *   6. Supports dry-run mode (default) and auto-execute mode
 *
 * Safety: dry-run by default. Set TASK_DISPATCH_AUTO_EXECUTE=1 to enable
 * automatic PR creation. Even in auto mode, only "trivial" and "small"
 * complexity tasks execute without approval.
 */

import { executeCodeTask, type CodingResult } from "./coding-agent.js";
import { getAgentState, type GeneratedTask, type AgentState } from "./agent.js";
import { memoryStore } from "./memory/store.js";
import { broadcast } from "./events.js";
import { recommendProvider } from "./rate-limiter.js";
import { remediateTask, type RemediationRecord } from "./task-remediator.js";
import { config } from "./config.js";

// ── Types ──

export type DispatchResult = {
  dispatched: number;
  succeeded: number;
  failed: number;
  skipped: number;
  results: Array<{
    taskId: string;
    title: string;
    status: "success" | "failed" | "skipped" | "dry-run" | "remediated";
    result?: CodingResult;
    reason?: string;
    remediation?: RemediationRecord;
  }>;
  remediated: number;
  durationMs: number;
};

export type DispatchConfig = {
  /** Only dispatch code tasks (skip plan/diagnose/review) */
  codeOnly: boolean;
  /** Dry-run mode — generate code but don't create branches/PRs */
  dryRun: boolean;
  /** Max complexity to auto-execute without approval */
  maxAutoComplexity: "trivial" | "small" | "medium" | "large";
  /** Max tasks to dispatch per cycle */
  maxTasksPerCycle: number;
  /** Delay between task dispatches (ms) — pacing */
  interTaskDelayMs: number;
  /** Enable auto-remediation of failed tasks */
  remediationEnabled: boolean;
  /** Default owner/repo for task execution */
  defaultOwner: string;
  defaultRepo: string;
};

// ── State ──

const dispatchConfig: DispatchConfig = {
  codeOnly: true,
  dryRun: process.env.TASK_DISPATCH_AUTO_EXECUTE !== "1",
  maxAutoComplexity: (process.env.TASK_DISPATCH_MAX_COMPLEXITY as any) ?? "small",
  maxTasksPerCycle: Number(process.env.TASK_DISPATCH_MAX_PER_CYCLE ?? 5),
  interTaskDelayMs: Number(process.env.TASK_DISPATCH_DELAY_MS ?? 5000),
  remediationEnabled: process.env.TASK_DISPATCH_REMEDIATION !== "0",
  defaultOwner: process.env.TASK_DISPATCH_OWNER ?? "",
  defaultRepo: process.env.TASK_DISPATCH_REPO ?? "",
};

let dispatching = false;
let lastDispatch: DispatchResult | null = null;

// ── Complexity ordering for auto-execute gate ──

const COMPLEXITY_ORDER: Record<string, number> = {
  trivial: 0,
  small: 1,
  medium: 2,
  large: 3,
};

function complexityAllowed(taskComplexity: string, maxAllowed: string): boolean {
  return (COMPLEXITY_ORDER[taskComplexity] ?? 99) <= (COMPLEXITY_ORDER[maxAllowed] ?? 0);
}

// ── Topological sort for dependency ordering ──

function topoSort(tasks: GeneratedTask[]): GeneratedTask[] {
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const visited = new Set<string>();
  const sorted: GeneratedTask[] = [];

  function visit(task: GeneratedTask): void {
    if (visited.has(task.id)) return;
    visited.add(task.id);
    for (const depId of task.dependencies) {
      const dep = taskMap.get(depId);
      if (dep) visit(dep);
    }
    sorted.push(task);
  }

  for (const task of tasks) visit(task);
  return sorted;
}

// ── Extract owner/repo from task or use defaults ──

function resolveRepo(task: GeneratedTask): { owner: string; repo: string } | null {
  // Tasks have a repo field via their parent RoadmapItem
  // The agent state stores generatedTasks flat, but we can find the parent
  const agentState = getAgentState();
  for (const item of agentState.roadmapItems) {
    if (item.tasks.some((t) => t.id === task.id)) {
      const parts = item.repo.split("/");
      if (parts.length === 2) return { owner: parts[0], repo: parts[1] };
    }
  }

  // Fall back to config defaults
  if (dispatchConfig.defaultOwner && dispatchConfig.defaultRepo) {
    return { owner: dispatchConfig.defaultOwner, repo: dispatchConfig.defaultRepo };
  }

  return null;
}

// ── Core Dispatch ──

/**
 * Dispatch all pending code tasks from the agent state.
 * Respects dependency ordering, complexity gates, and rate limits.
 */
export async function dispatchTasks(opts?: Partial<DispatchConfig>): Promise<DispatchResult> {
  if (dispatching) {
    return {
      dispatched: 0, succeeded: 0, failed: 0, skipped: 0, remediated: 0,
      results: [{ taskId: "", title: "", status: "skipped", reason: "Dispatch already in progress" }],
      durationMs: 0,
    };
  }

  dispatching = true;
  const start = Date.now();
  const effectiveConfig = { ...dispatchConfig, ...opts };

  console.log(`[task-dispatcher] starting dispatch (dryRun=${effectiveConfig.dryRun}, maxTasks=${effectiveConfig.maxTasksPerCycle})`);
  broadcast("task-dispatcher:start", { dryRun: effectiveConfig.dryRun });

  const result: DispatchResult = {
    dispatched: 0, succeeded: 0, failed: 0, skipped: 0, remediated: 0,
    results: [], durationMs: 0,
  };

  try {
    const agentState = getAgentState();
    let tasks = agentState.generatedTasks;

    // Filter to code tasks only if configured
    if (effectiveConfig.codeOnly) {
      tasks = tasks.filter((t) => t.type === "code");
    }

    if (!tasks.length) {
      console.log("[task-dispatcher] no executable tasks found");
      result.results.push({ taskId: "", title: "", status: "skipped", reason: "No executable tasks" });
      return result;
    }

    // Topological sort for dependency ordering
    const sorted = topoSort(tasks);
    const toDispatch = sorted.slice(0, effectiveConfig.maxTasksPerCycle);

    console.log(`[task-dispatcher] ${toDispatch.length} tasks queued (${sorted.length} total, ${effectiveConfig.maxTasksPerCycle} max/cycle)`);

    const completedIds = new Set<string>();

    for (const task of toDispatch) {
      // Check dependencies are satisfied
      const unmetDeps = task.dependencies.filter(
        (d) => !completedIds.has(d) && sorted.some((t) => t.id === d)
      );
      if (unmetDeps.length > 0) {
        result.skipped++;
        result.results.push({
          taskId: task.id,
          title: task.title,
          status: "skipped",
          reason: `Unmet dependencies: ${unmetDeps.join(", ")}`,
        });
        continue;
      }

      // Complexity gate for auto-execute
      if (!effectiveConfig.dryRun && !complexityAllowed(task.estimatedComplexity, effectiveConfig.maxAutoComplexity)) {
        result.skipped++;
        result.results.push({
          taskId: task.id,
          title: task.title,
          status: "skipped",
          reason: `Complexity ${task.estimatedComplexity} exceeds auto-execute limit (${effectiveConfig.maxAutoComplexity})`,
        });
        continue;
      }

      // Resolve target repo
      const repo = resolveRepo(task);
      if (!repo) {
        result.skipped++;
        result.results.push({
          taskId: task.id,
          title: task.title,
          status: "skipped",
          reason: "No target repo resolved (set TASK_DISPATCH_OWNER/REPO)",
        });
        continue;
      }

      // Check provider availability before dispatching
      const rec = recommendProvider();
      if (rec.delayMs > 30000) {
        console.log(`[task-dispatcher] pausing dispatch — LLM providers need ${Math.ceil(rec.delayMs / 1000)}s cooldown`);
        await new Promise((r) => setTimeout(r, Math.min(rec.delayMs, 30000)));
      }

      // Execute
      console.log(`[task-dispatcher] dispatching: ${task.title} → ${repo.owner}/${repo.repo} (${effectiveConfig.dryRun ? "dry-run" : "LIVE"})`);
      broadcast("task-dispatcher:task", { taskId: task.id, title: task.title, repo: `${repo.owner}/${repo.repo}` });

      try {
        const codingResult = await executeCodeTask(task, repo.owner, repo.repo, {
          dryRun: effectiveConfig.dryRun,
        });

        result.dispatched++;
        if (codingResult.success) {
          result.succeeded++;
          completedIds.add(task.id);
          result.results.push({
            taskId: task.id,
            title: task.title,
            status: effectiveConfig.dryRun ? "dry-run" : "success",
            result: codingResult,
          });
        } else if (effectiveConfig.remediationEnabled && codingResult.error) {
          // ── Auto-remediation: retry with progressive strategies ──
          console.log(`[task-dispatcher] task failed, invoking remediator: ${task.id}`);
          try {
            const remediation = await remediateTask(
              task, repo.owner, repo.repo, codingResult.error,
              { dryRun: effectiveConfig.dryRun },
            );
            if (remediation.resolved) {
              result.remediated++;
              result.succeeded++;
              completedIds.add(task.id);
              result.results.push({
                taskId: task.id,
                title: task.title,
                status: "remediated",
                result: remediation.finalResult,
                remediation,
              });
            } else {
              result.failed++;
              result.results.push({
                taskId: task.id,
                title: task.title,
                status: "failed",
                result: codingResult,
                reason: `Remediation exhausted (${remediation.attempts.length} attempts): ${codingResult.error}`,
                remediation,
              });
            }
          } catch (remErr) {
            result.failed++;
            result.results.push({
              taskId: task.id,
              title: task.title,
              status: "failed",
              result: codingResult,
              reason: `Remediation error: ${(remErr as Error).message}`,
            });
          }
        } else {
          result.failed++;
          result.results.push({
            taskId: task.id,
            title: task.title,
            status: "failed",
            result: codingResult,
            reason: codingResult.error,
          });
        }
      } catch (err) {
        result.failed++;
        result.results.push({
          taskId: task.id,
          title: task.title,
          status: "failed",
          reason: (err as Error).message,
        });
      }

      // Inter-task pacing
      if (effectiveConfig.interTaskDelayMs > 0) {
        await new Promise((r) => setTimeout(r, effectiveConfig.interTaskDelayMs));
      }
    }
  } catch (err) {
    console.error(`[task-dispatcher] fatal: ${(err as Error).message}`);
  } finally {
    result.durationMs = Date.now() - start;
    dispatching = false;
    lastDispatch = result;

    // Log to memory store
    await memoryStore.add({
      title: `Task Dispatch: ${result.dispatched} dispatched, ${result.succeeded} succeeded, ${result.failed} failed`,
      details: result.results
        .map((r) => `[${r.status}] ${r.title}${r.reason ? ` — ${r.reason}` : ""}`)
        .join("\n"),
      tags: ["task-dispatcher", "auto"],
      source: "task-dispatcher",
    }).catch(() => {});

    broadcast("task-dispatcher:complete", {
      dispatched: result.dispatched,
      succeeded: result.succeeded,
      remediated: result.remediated,
      failed: result.failed,
      skipped: result.skipped,
      durationMs: result.durationMs,
    });

    console.log(
      `[task-dispatcher] complete: ${result.dispatched} dispatched, ` +
      `${result.succeeded} succeeded (${result.remediated} remediated), ${result.failed} failed, ` +
      `${result.skipped} skipped in ${result.durationMs}ms`
    );
  }

  return result;
}

// ── API Accessors ──

export function getDispatchConfig(): DispatchConfig {
  return { ...dispatchConfig };
}

export function updateDispatchConfig(opts: Partial<DispatchConfig>): DispatchConfig {
  Object.assign(dispatchConfig, opts);
  return { ...dispatchConfig };
}

export function getLastDispatch(): DispatchResult | null {
  return lastDispatch;
}

export function isDispatching(): boolean {
  return dispatching;
}
