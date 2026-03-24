/**
 * Continuous Agent Loop — runs agent cycles on a configurable interval.
 *
 * Four-phase cycle:
 *   Phase 1: Fetch new knowledge sources (external docs)
 *   Phase 2: Run the agent (roadmap parsing + task generation)
 *   Phase 3: Dispatch executable tasks to the coding agent
 *   Phase 4: Update roadmaps with dispatch results (closes the loop)
 *
 * Rate limiting is now handled centrally by rate-limiter.ts.
 * The loop respects provider pacing and cost budgets automatically.
 *
 * The loop is opt-in: starts only when AGENT_LOOP_ENABLED=1 in .env
 * or triggered via the /agent/loop/start API endpoint.
 */

import { runAgent, getAgentState } from "./agent.js";
import { fetchAllSources } from "./knowledge/fetcher.js";
import { KnowledgeIngester } from "./knowledge/ingester.js";
import { dispatchTasks, type DispatchResult } from "./task-dispatcher.js";
import { updateRoadmaps, type RoadmapUpdate } from "./roadmap-updater.js";
import { broadcast } from "./events.js";
import { config } from "./config.js";
import { recordCycle } from "./kpi-tracker.js";
import { getStats as getRateLimiterStats } from "./rate-limiter.js";
import { getHealerStats } from "./self-healer.js";

export type AgentLoopState = {
  running: boolean;
  intervalMs: number;
  totalCycles: number;
  lastCycleAt: string | null;
  lastCycleDurationMs: number | null;
  lastDispatch: DispatchResult | null;
  errors: string[];
  /** Whether task dispatch is enabled in the loop */
  dispatchEnabled: boolean;
};

const loopState: AgentLoopState = {
  running: false,
  intervalMs: Number(process.env.AGENT_LOOP_INTERVAL_MS ?? 30 * 60 * 1000),
  totalCycles: 0,
  lastCycleAt: null,
  lastCycleDurationMs: null,
  lastDispatch: null,
  errors: [],
  dispatchEnabled: process.env.TASK_DISPATCH_IN_LOOP !== "0",
};

let loopTimer: NodeJS.Timeout | null = null;

/** Single cycle: fetch knowledge → run agent → dispatch tasks */
async function runCycle(): Promise<void> {
  if (getAgentState().running) {
    console.log("[agent-loop] skipping cycle — agent already running");
    return;
  }

  const start = Date.now();
  console.log(`[agent-loop] cycle #${loopState.totalCycles + 1} starting...`);
  broadcast("agent-loop:cycle-start", { cycle: loopState.totalCycles + 1 });

  try {
    // Phase 1: Fetch new knowledge sources
    console.log("[agent-loop] phase 1: fetching knowledge sources...");
    const fetchResult = await fetchAllSources();
    if (fetchResult.fetched > 0) {
      console.log(`[agent-loop] fetched ${fetchResult.fetched} new files, re-ingesting...`);
      const ingester = new KnowledgeIngester();
      await ingester.ingest();
    }

    // Phase 2: Run the agent (roadmap parsing + task generation)
    console.log("[agent-loop] phase 2: running agent...");
    const agentResult = await runAgent();

    // Phase 3: Dispatch executable tasks
    let dispatchResult: DispatchResult | null = null;
    if (loopState.dispatchEnabled && agentResult.generatedTasks.length > 0) {
      console.log("[agent-loop] phase 3: dispatching tasks...");
      dispatchResult = await dispatchTasks();
      loopState.lastDispatch = dispatchResult;
    } else if (!loopState.dispatchEnabled) {
      console.log("[agent-loop] phase 3: task dispatch disabled (set TASK_DISPATCH_IN_LOOP=1)");
    } else {
      console.log("[agent-loop] phase 3: no tasks to dispatch");
    }

    // Phase 4: Update roadmaps with dispatch results (closes the recursion loop)
    let roadmapUpdates: RoadmapUpdate[] = [];
    if (dispatchResult && dispatchResult.dispatched > 0) {
      console.log("[agent-loop] phase 4: updating roadmaps...");
      try {
        roadmapUpdates = await updateRoadmaps();
        const updatedCount = roadmapUpdates.filter((r) => r.updated).length;
        console.log(`[agent-loop] phase 4: ${updatedCount}/${roadmapUpdates.length} roadmaps updated`);
      } catch (err) {
        console.warn(`[agent-loop] phase 4 failed: ${(err as Error).message}`);
      }
    } else {
      console.log("[agent-loop] phase 4: no dispatch results, skipping roadmap update");
    }

    const elapsed = Date.now() - start;
    loopState.totalCycles++;
    loopState.lastCycleAt = new Date().toISOString();
    loopState.lastCycleDurationMs = elapsed;

    // Record KPIs for this cycle
    const rateLimiterStats = getRateLimiterStats();
    const healerStats = getHealerStats();
    const tokenUsage = {
      totalTokens:
        (rateLimiterStats.openrouter?.usage?.hourly?.totalTokens ?? 0) +
        (rateLimiterStats.bedrock?.usage?.hourly?.totalTokens ?? 0) +
        (rateLimiterStats.ollama?.usage?.hourly?.totalTokens ?? 0),
      estimatedCostUsd:
        (rateLimiterStats.openrouter?.usage?.hourly?.estimatedCostUsd ?? 0) +
        (rateLimiterStats.bedrock?.usage?.hourly?.estimatedCostUsd ?? 0),
    };

    const circuitBreakerTrips = Object.values(healerStats.providerHealth)
      .filter((h: any) => h.disabled || h.recoveryMode).length;

    recordCycle({
      durationMs: elapsed,
      roadmapItemsParsed: agentResult.roadmapItems.length,
      tasksGenerated: agentResult.generatedTasks.length,
      dispatch: dispatchResult,
      agentErrors: agentResult.errors.length,
      providerFailures: healerStats.byCategory?.["provider-failure"] ?? 0,
      circuitBreakerTrips,
      roadmapItemsCompleted: roadmapUpdates
        .reduce((s, r) => s + r.itemsMarkedDone.length, 0),
      reposUpdated: roadmapUpdates.filter((r) => r.updated).length,
      tokenUsage,
    });

    console.log(
      `[agent-loop] cycle #${loopState.totalCycles} complete in ${elapsed}ms — ` +
      `${agentResult.roadmapItems.length} items, ${agentResult.generatedTasks.length} tasks, ` +
      `${agentResult.errors.length} errors` +
      (dispatchResult ? `, ${dispatchResult.succeeded}/${dispatchResult.dispatched} dispatched` : "")
    );

    broadcast("agent-loop:cycle-complete", {
      cycle: loopState.totalCycles,
      durationMs: elapsed,
      items: agentResult.roadmapItems.length,
      tasks: agentResult.generatedTasks.length,
      errors: agentResult.errors.length,
      knowledgeFetched: fetchResult.fetched,
      dispatch: dispatchResult ? {
        dispatched: dispatchResult.dispatched,
        succeeded: dispatchResult.succeeded,
        failed: dispatchResult.failed,
      } : null,
    });
  } catch (err) {
    const msg = (err as Error).message;
    loopState.errors.push(`cycle ${loopState.totalCycles + 1}: ${msg}`);
    console.error(`[agent-loop] cycle failed: ${msg}`);
    broadcast("agent-loop:cycle-error", { error: msg });
  }
}

/** Start the continuous loop */
export function startAgentLoop(intervalMs?: number): AgentLoopState {
  if (loopState.running) return loopState;

  if (intervalMs) loopState.intervalMs = intervalMs;
  loopState.running = true;
  loopState.errors = [];

  // Run first cycle immediately, then on interval
  runCycle().catch((err) => console.error("[agent-loop] initial cycle failed:", err));

  loopTimer = setInterval(() => {
    runCycle().catch((err) => console.error("[agent-loop] cycle failed:", err));
  }, loopState.intervalMs);

  console.log(`[agent-loop] started — interval: ${loopState.intervalMs}ms`);
  broadcast("agent-loop:started", { intervalMs: loopState.intervalMs });

  return loopState;
}

/** Stop the continuous loop */
export function stopAgentLoop(): AgentLoopState {
  if (!loopState.running) return loopState;

  if (loopTimer) { clearInterval(loopTimer); loopTimer = null; }
  loopState.running = false;

  console.log("[agent-loop] stopped");
  broadcast("agent-loop:stopped", { totalCycles: loopState.totalCycles });

  return loopState;
}

/** Get current loop state */
export function getAgentLoopState(): AgentLoopState {
  return { ...loopState };
}

/** Update loop configuration */
export function updateLoopConfig(opts: {
  intervalMs?: number;
  dispatchEnabled?: boolean;
}): AgentLoopState {
  if (opts.intervalMs) {
    loopState.intervalMs = opts.intervalMs;
    if (loopState.running && loopTimer) {
      clearInterval(loopTimer);
      loopTimer = setInterval(() => {
        runCycle().catch((err) => console.error("[agent-loop] cycle failed:", err));
      }, loopState.intervalMs);
    }
  }
  if (opts.dispatchEnabled !== undefined) {
    loopState.dispatchEnabled = opts.dispatchEnabled;
  }
  return { ...loopState };
}
