/**
 * Continuous Agent Loop — runs agent cycles on a configurable interval
 * with rate limiting to avoid abusing API limitations.
 * 
 * Rate-limit strategy:
 *   - Configurable interval (default: 30 min)
 *   - Tracks API calls per window
 *   - Backs off if approaching rate limits
 *   - Skips cycle if previous run is still in progress
 * 
 * The loop is opt-in: starts only when AGENT_LOOP_ENABLED=1 in .env
 * or triggered via the /agent/loop/start API endpoint.
 */

import { runAgent, getAgentState } from "./agent.js";
import { fetchAllSources } from "./knowledge/fetcher.js";
import { KnowledgeIngester } from "./knowledge/ingester.js";
import { broadcast } from "./events.js";
import { config } from "./config.js";

export type AgentLoopState = {
  running: boolean;
  intervalMs: number;
  totalCycles: number;
  lastCycleAt: string | null;
  lastCycleDurationMs: number | null;
  errors: string[];
  apiCallsThisWindow: number;
  maxApiCallsPerWindow: number;
};

const loopState: AgentLoopState = {
  running: false,
  intervalMs: Number(process.env.AGENT_LOOP_INTERVAL_MS ?? 30 * 60 * 1000), // 30 min default
  totalCycles: 0,
  lastCycleAt: null,
  lastCycleDurationMs: null,
  errors: [],
  apiCallsThisWindow: 0,
  maxApiCallsPerWindow: Number(process.env.AGENT_LOOP_MAX_API_CALLS ?? 100),
};

let loopTimer: NodeJS.Timeout | null = null;
let windowResetTimer: NodeJS.Timeout | null = null;

/** Track an API call for rate limiting */
export function trackApiCall(): void {
  loopState.apiCallsThisWindow++;
}

/** Check if we're approaching rate limits */
function isRateLimited(): boolean {
  return loopState.apiCallsThisWindow >= loopState.maxApiCallsPerWindow;
}

/** Single cycle: fetch knowledge sources → ingest → run agent */
async function runCycle(): Promise<void> {
  if (getAgentState().running) {
    console.log("[agent-loop] skipping cycle — agent already running");
    return;
  }

  if (isRateLimited()) {
    console.log(`[agent-loop] skipping cycle — rate limit (${loopState.apiCallsThisWindow}/${loopState.maxApiCallsPerWindow} calls)`);
    broadcast("agent-loop:rate-limited", {
      calls: loopState.apiCallsThisWindow,
      max: loopState.maxApiCallsPerWindow,
    });
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

    const elapsed = Date.now() - start;
    loopState.totalCycles++;
    loopState.lastCycleAt = new Date().toISOString();
    loopState.lastCycleDurationMs = elapsed;

    console.log(
      `[agent-loop] cycle #${loopState.totalCycles} complete in ${elapsed}ms — ` +
      `${agentResult.roadmapItems.length} items, ${agentResult.generatedTasks.length} tasks, ` +
      `${agentResult.errors.length} errors`
    );

    broadcast("agent-loop:cycle-complete", {
      cycle: loopState.totalCycles,
      durationMs: elapsed,
      items: agentResult.roadmapItems.length,
      tasks: agentResult.generatedTasks.length,
      errors: agentResult.errors.length,
      knowledgeFetched: fetchResult.fetched,
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

  // Reset API call counter every hour
  windowResetTimer = setInterval(() => {
    loopState.apiCallsThisWindow = 0;
  }, 60 * 60 * 1000);

  // Run first cycle immediately, then on interval
  runCycle().catch((err) => console.error("[agent-loop] initial cycle failed:", err));

  loopTimer = setInterval(() => {
    runCycle().catch((err) => console.error("[agent-loop] cycle failed:", err));
  }, loopState.intervalMs);

  console.log(`[agent-loop] started — interval: ${loopState.intervalMs}ms, max calls/window: ${loopState.maxApiCallsPerWindow}`);
  broadcast("agent-loop:started", { intervalMs: loopState.intervalMs });

  return loopState;
}

/** Stop the continuous loop */
export function stopAgentLoop(): AgentLoopState {
  if (!loopState.running) return loopState;

  if (loopTimer) { clearInterval(loopTimer); loopTimer = null; }
  if (windowResetTimer) { clearInterval(windowResetTimer); windowResetTimer = null; }
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
  maxApiCallsPerWindow?: number;
}): AgentLoopState {
  if (opts.intervalMs) {
    loopState.intervalMs = opts.intervalMs;
    // Restart timer if running
    if (loopState.running && loopTimer) {
      clearInterval(loopTimer);
      loopTimer = setInterval(() => {
        runCycle().catch((err) => console.error("[agent-loop] cycle failed:", err));
      }, loopState.intervalMs);
    }
  }
  if (opts.maxApiCallsPerWindow) {
    loopState.maxApiCallsPerWindow = opts.maxApiCallsPerWindow;
  }
  return { ...loopState };
}
