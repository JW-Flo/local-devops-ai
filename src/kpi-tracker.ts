/**
 * KPI Tracker — production-grade metrics for autonomous DevOps agent.
 *
 * Tracks cycle-over-cycle trends, task success rates, code quality
 * signals, cost efficiency, remediation effectiveness, and SLA
 * compliance. Persists to SQLite for historical analysis.
 *
 * KPI Categories:
 *   1. Throughput   — tasks dispatched, completed per cycle/hour/day
 *   2. Quality      — success rate, remediation rate, failure patterns
 *   3. Efficiency   — cost per task, LLM tokens per task, cycle duration
 *   4. Reliability  — provider uptime, circuit breaker trips, error rate
 *   5. Velocity     — roadmap items completed, trend direction
 */

import { withDb } from "./storage/sqlite.js";
import { broadcast } from "./events.js";
import type { DispatchResult } from "./task-dispatcher.js";
import type { RemediationStats } from "./task-remediator.js";

// ── Types ──

export type CycleSnapshot = {
  cycleNumber: number;
  timestamp: string;
  durationMs: number;
  // Throughput
  roadmapItemsParsed: number;
  tasksGenerated: number;
  tasksDispatched: number;
  tasksSucceeded: number;
  tasksFailed: number;
  tasksRemediated: number;
  tasksSkipped: number;
  // Quality
  successRate: number;        // 0-1
  remediationRate: number;    // fraction of failures recovered
  // Efficiency
  totalTokens: number;
  estimatedCostUsd: number;
  tokensPerTask: number;
  costPerTask: number;
  // Reliability
  providerFailures: number;
  circuitBreakerTrips: number;
  agentErrors: number;
  // Velocity
  roadmapItemsCompleted: number;
  reposUpdated: number;
};

export type KPIDashboard = {
  // Current cycle
  lastCycle: CycleSnapshot | null;
  // Aggregate stats
  totalCycles: number;
  totalTasksDispatched: number;
  totalTasksSucceeded: number;
  totalTasksFailed: number;
  totalTasksRemediated: number;
  // Rolling averages (last 10 cycles)
  rolling: {
    avgSuccessRate: number;
    avgRemediationRate: number;
    avgCycleDurationMs: number;
    avgTasksPerCycle: number;
    avgCostPerCycle: number;
    avgTokensPerTask: number;
    trend: "improving" | "stable" | "degrading";
  };
  // Cost tracking
  totalCostUsd: number;
  totalTokens: number;
  // SLA compliance
  sla: {
    targetSuccessRate: number;
    currentSuccessRate: number;
    compliant: boolean;
    cyclesSinceViolation: number;
  };
  // Top failure reasons
  topFailures: Array<{ reason: string; count: number }>;
  // History
  recentCycles: CycleSnapshot[];
};


// ── Configuration ──

const SLA_TARGET_SUCCESS_RATE = Number(process.env.KPI_SLA_SUCCESS_RATE ?? 0.75);
const MAX_HISTORY = 100;
const ROLLING_WINDOW = 10;

// ── State ──

const cycleHistory: CycleSnapshot[] = [];
const failureReasons: Map<string, number> = new Map();
let totalCycles = 0;
let totalDispatched = 0;
let totalSucceeded = 0;
let totalFailed = 0;
let totalRemediated = 0;
let totalCostUsd = 0;
let totalTokens = 0;
let cyclesSinceViolation = 0;

// ── SQLite Persistence ──

async function ensureTable(): Promise<void> {
  try {
    await withDb((db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS kpi_cycles (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          cycle_number INTEGER NOT NULL,
          timestamp TEXT NOT NULL,
          duration_ms INTEGER NOT NULL,
          items_parsed INTEGER DEFAULT 0,
          tasks_generated INTEGER DEFAULT 0,
          tasks_dispatched INTEGER DEFAULT 0,
          tasks_succeeded INTEGER DEFAULT 0,
          tasks_failed INTEGER DEFAULT 0,
          tasks_remediated INTEGER DEFAULT 0,
          tasks_skipped INTEGER DEFAULT 0,
          success_rate REAL DEFAULT 0,
          remediation_rate REAL DEFAULT 0,
          total_tokens INTEGER DEFAULT 0,
          estimated_cost_usd REAL DEFAULT 0,
          provider_failures INTEGER DEFAULT 0,
          circuit_breaker_trips INTEGER DEFAULT 0,
          agent_errors INTEGER DEFAULT 0,
          items_completed INTEGER DEFAULT 0,
          repos_updated INTEGER DEFAULT 0
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS kpi_failures (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          reason TEXT NOT NULL,
          count INTEGER DEFAULT 1,
          last_seen TEXT NOT NULL
        )
      `);
    });
  } catch (err) {
    console.warn(`[kpi] table init failed: ${(err as Error).message}`);
  }
}


async function persistCycle(snapshot: CycleSnapshot): Promise<void> {
  try {
    await withDb((db) => {
      const stmt = db.prepare(`
        INSERT INTO kpi_cycles (
          cycle_number, timestamp, duration_ms, items_parsed,
          tasks_generated, tasks_dispatched, tasks_succeeded,
          tasks_failed, tasks_remediated, tasks_skipped,
          success_rate, remediation_rate, total_tokens,
          estimated_cost_usd, provider_failures,
          circuit_breaker_trips, agent_errors,
          items_completed, repos_updated
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run([
        snapshot.cycleNumber, snapshot.timestamp, snapshot.durationMs,
        snapshot.roadmapItemsParsed, snapshot.tasksGenerated,
        snapshot.tasksDispatched, snapshot.tasksSucceeded,
        snapshot.tasksFailed, snapshot.tasksRemediated,
        snapshot.tasksSkipped, snapshot.successRate,
        snapshot.remediationRate, snapshot.totalTokens,
        snapshot.estimatedCostUsd, snapshot.providerFailures,
        snapshot.circuitBreakerTrips, snapshot.agentErrors,
        snapshot.roadmapItemsCompleted, snapshot.reposUpdated,
      ]);
      stmt.free();
    }, { persist: true });
  } catch (err) {
    console.warn(`[kpi] persist failed: ${(err as Error).message}`);
  }
}

async function persistFailure(reason: string): Promise<void> {
  try {
    await withDb((db) => {
      const check = db.prepare(`SELECT id, count FROM kpi_failures WHERE reason = ?`);
      check.bind([reason]);
      if (check.step()) {
        const row = check.getAsObject();
        check.free();
        const upd = db.prepare(`UPDATE kpi_failures SET count = count + 1, last_seen = ? WHERE id = ?`);
        upd.run([new Date().toISOString(), row.id]);
        upd.free();
      } else {
        check.free();
        const ins = db.prepare(`INSERT INTO kpi_failures (reason, count, last_seen) VALUES (?, 1, ?)`);
        ins.run([reason, new Date().toISOString()]);
        ins.free();
      }
    }, { persist: true });
  } catch (err) {
    console.warn(`[kpi] failure persist failed: ${(err as Error).message}`);
  }
}

async function loadHistory(): Promise<void> {
  try {
    await withDb((db) => {
      // Load cycles
      const stmt = db.prepare(`SELECT * FROM kpi_cycles ORDER BY id DESC LIMIT ?`);
      stmt.bind([MAX_HISTORY]);
      const rows: any[] = [];
      while (stmt.step()) {
        rows.push(stmt.getAsObject());
      }
      stmt.free();

      for (const row of rows.reverse()) {
        cycleHistory.push({
          cycleNumber: row.cycle_number as number,
          timestamp: row.timestamp as string,
          durationMs: row.duration_ms as number,
          roadmapItemsParsed: row.items_parsed as number,
          tasksGenerated: row.tasks_generated as number,
          tasksDispatched: row.tasks_dispatched as number,
          tasksSucceeded: row.tasks_succeeded as number,
          tasksFailed: row.tasks_failed as number,
          tasksRemediated: row.tasks_remediated as number,
          tasksSkipped: row.tasks_skipped as number,
          successRate: row.success_rate as number,
          remediationRate: row.remediation_rate as number,
          totalTokens: row.total_tokens as number,
          estimatedCostUsd: row.estimated_cost_usd as number,
          tokensPerTask: (row.tasks_dispatched as number) > 0
            ? (row.total_tokens as number) / (row.tasks_dispatched as number) : 0,
          costPerTask: (row.tasks_dispatched as number) > 0
            ? (row.estimated_cost_usd as number) / (row.tasks_dispatched as number) : 0,
          providerFailures: row.provider_failures as number,
          circuitBreakerTrips: row.circuit_breaker_trips as number,
          agentErrors: row.agent_errors as number,
          roadmapItemsCompleted: row.items_completed as number,
          reposUpdated: row.repos_updated as number,
        });
      }

      totalCycles = cycleHistory.length;
      for (const c of cycleHistory) {
        totalDispatched += c.tasksDispatched;
        totalSucceeded += c.tasksSucceeded;
        totalFailed += c.tasksFailed;
        totalRemediated += c.tasksRemediated;
        totalCostUsd += c.estimatedCostUsd;
        totalTokens += c.totalTokens;
      }

      // Load failure reasons
      const fStmt = db.prepare(`SELECT reason, count FROM kpi_failures ORDER BY count DESC`);
      while (fStmt.step()) {
        const f = fStmt.getAsObject();
        failureReasons.set(f.reason as string, f.count as number);
      }
      fStmt.free();

      if (totalCycles > 0) {
        console.log(`[kpi] loaded ${totalCycles} historical cycles`);
      }
    });
  } catch {
    // Fresh start — no history yet
  }
}


// ── Core Recording ──

/**
 * Record a completed agent cycle's metrics.
 * Called at the end of each agent-loop cycle.
 */
export function recordCycle(data: {
  durationMs: number;
  roadmapItemsParsed: number;
  tasksGenerated: number;
  dispatch: DispatchResult | null;
  agentErrors: number;
  providerFailures: number;
  circuitBreakerTrips: number;
  roadmapItemsCompleted: number;
  reposUpdated: number;
  tokenUsage: { totalTokens: number; estimatedCostUsd: number };
}): CycleSnapshot {
  totalCycles++;

  const dispatched = data.dispatch?.dispatched ?? 0;
  const succeeded = data.dispatch?.succeeded ?? 0;
  const failed = data.dispatch?.failed ?? 0;
  const remediated = data.dispatch?.remediated ?? 0;
  const skipped = data.dispatch?.skipped ?? 0;

  const successRate = dispatched > 0 ? succeeded / dispatched : 0;
  const remediationRate = (failed + remediated) > 0
    ? remediated / (failed + remediated) : 0;

  const snapshot: CycleSnapshot = {
    cycleNumber: totalCycles,
    timestamp: new Date().toISOString(),
    durationMs: data.durationMs,
    roadmapItemsParsed: data.roadmapItemsParsed,
    tasksGenerated: data.tasksGenerated,
    tasksDispatched: dispatched,
    tasksSucceeded: succeeded,
    tasksFailed: failed,
    tasksRemediated: remediated,
    tasksSkipped: skipped,
    successRate,
    remediationRate,
    totalTokens: data.tokenUsage.totalTokens,
    estimatedCostUsd: data.tokenUsage.estimatedCostUsd,
    tokensPerTask: dispatched > 0 ? data.tokenUsage.totalTokens / dispatched : 0,
    costPerTask: dispatched > 0 ? data.tokenUsage.estimatedCostUsd / dispatched : 0,
    providerFailures: data.providerFailures,
    circuitBreakerTrips: data.circuitBreakerTrips,
    agentErrors: data.agentErrors,
    roadmapItemsCompleted: data.roadmapItemsCompleted,
    reposUpdated: data.reposUpdated,
  };

  // Update aggregates
  totalDispatched += dispatched;
  totalSucceeded += succeeded;
  totalFailed += failed;
  totalRemediated += remediated;
  totalCostUsd += snapshot.estimatedCostUsd;
  totalTokens += snapshot.totalTokens;

  // SLA check
  if (successRate >= SLA_TARGET_SUCCESS_RATE || dispatched === 0) {
    cyclesSinceViolation++;
  } else {
    cyclesSinceViolation = 0;
    console.warn(
      `[kpi] SLA VIOLATION: success rate ${(successRate * 100).toFixed(1)}% ` +
      `below target ${(SLA_TARGET_SUCCESS_RATE * 100).toFixed(1)}%`
    );
    broadcast("kpi:sla-violation", {
      cycle: totalCycles, successRate, target: SLA_TARGET_SUCCESS_RATE,
    });
  }

  // Track failure reasons
  if (data.dispatch) {
    for (const r of data.dispatch.results) {
      if (r.status === "failed" && r.reason) {
        const normalized = normalizeFailureReason(r.reason);
        failureReasons.set(normalized, (failureReasons.get(normalized) ?? 0) + 1);
        persistFailure(normalized).catch(() => {});
      }
    }
  }

  // Store and persist (fire-and-forget to avoid blocking cycle)
  cycleHistory.push(snapshot);
  if (cycleHistory.length > MAX_HISTORY) cycleHistory.shift();
  persistCycle(snapshot).catch(() => {});

  broadcast("kpi:cycle-recorded", {
    cycle: totalCycles,
    successRate: snapshot.successRate,
    remediated: snapshot.tasksRemediated,
    cost: snapshot.estimatedCostUsd,
  });

  return snapshot;
}

function normalizeFailureReason(reason: string): string {
  const lower = reason.toLowerCase();
  if (lower.includes("no code changes")) return "LLM produced no code";
  if (lower.includes("providers exhausted")) return "All providers exhausted";
  if (lower.includes("timeout") || lower.includes("abort")) return "Request timeout";
  if (lower.includes("json") || lower.includes("parse")) return "JSON parse error";
  if (lower.includes("remediation exhausted")) return "Remediation exhausted";
  if (lower.includes("rate limit") || lower.includes("429")) return "Rate limited";
  return reason.slice(0, 60);
}


// ── Dashboard ──

/**
 * Get the full KPI dashboard with rolling averages and trend analysis.
 */
export function getKPIDashboard(): KPIDashboard {
  const lastCycle = cycleHistory.length > 0
    ? cycleHistory[cycleHistory.length - 1] : null;

  // Rolling window
  const window = cycleHistory.slice(-ROLLING_WINDOW);
  const windowDispatched = window.reduce((s, c) => s + c.tasksDispatched, 0);

  const rolling = {
    avgSuccessRate: window.length > 0
      ? window.reduce((s, c) => s + c.successRate, 0) / window.length : 0,
    avgRemediationRate: window.length > 0
      ? window.reduce((s, c) => s + c.remediationRate, 0) / window.length : 0,
    avgCycleDurationMs: window.length > 0
      ? window.reduce((s, c) => s + c.durationMs, 0) / window.length : 0,
    avgTasksPerCycle: window.length > 0
      ? windowDispatched / window.length : 0,
    avgCostPerCycle: window.length > 0
      ? window.reduce((s, c) => s + c.estimatedCostUsd, 0) / window.length : 0,
    avgTokensPerTask: windowDispatched > 0
      ? window.reduce((s, c) => s + c.totalTokens, 0) / windowDispatched : 0,
    trend: detectTrend(window),
  };

  // SLA
  const overallSuccessRate = totalDispatched > 0
    ? totalSucceeded / totalDispatched : 0;

  const sla = {
    targetSuccessRate: SLA_TARGET_SUCCESS_RATE,
    currentSuccessRate: overallSuccessRate,
    compliant: overallSuccessRate >= SLA_TARGET_SUCCESS_RATE,
    cyclesSinceViolation,
  };

  // Top failures
  const topFailures = Array.from(failureReasons.entries())
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    lastCycle,
    totalCycles,
    totalTasksDispatched: totalDispatched,
    totalTasksSucceeded: totalSucceeded,
    totalTasksFailed: totalFailed,
    totalTasksRemediated: totalRemediated,
    rolling,
    totalCostUsd,
    totalTokens,
    sla,
    topFailures,
    recentCycles: cycleHistory.slice(-20),
  };
}

function detectTrend(
  window: CycleSnapshot[],
): "improving" | "stable" | "degrading" {
  if (window.length < 3) return "stable";

  const half = Math.floor(window.length / 2);
  const firstHalf = window.slice(0, half);
  const secondHalf = window.slice(half);

  const avgFirst = firstHalf.reduce((s, c) => s + c.successRate, 0) / firstHalf.length;
  const avgSecond = secondHalf.reduce((s, c) => s + c.successRate, 0) / secondHalf.length;

  const delta = avgSecond - avgFirst;
  if (delta > 0.05) return "improving";
  if (delta < -0.05) return "degrading";
  return "stable";
}


// ── Initialization ──

export async function initKPITracker(): Promise<void> {
  await ensureTable();
  await loadHistory();
  console.log("[kpi] tracker initialized");
}

// ── Accessors ──

export function getCycleHistory(limit = 20): CycleSnapshot[] {
  return cycleHistory.slice(-limit);
}

export async function resetKPIs(): Promise<void> {
  cycleHistory.length = 0;
  failureReasons.clear();
  totalCycles = 0;
  totalDispatched = 0;
  totalSucceeded = 0;
  totalFailed = 0;
  totalRemediated = 0;
  totalCostUsd = 0;
  totalTokens = 0;
  cyclesSinceViolation = 0;
  try {
    await withDb((db) => {
      db.exec(`DELETE FROM kpi_cycles`);
      db.exec(`DELETE FROM kpi_failures`);
    }, { persist: true });
  } catch { /* silent */ }
}
