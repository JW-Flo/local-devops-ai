/**
 * Self-Healer — autonomous remediation engine for the gateway.
 * 
 * Capabilities:
 *   1. Port conflict resolution (kill stale listeners before bind)
 *   2. Hung process / LLM call detection with timeout enforcement
 *   3. Historical issue tracking in Qdrant (issues collection)
 *   4. Automatic config adjustment based on failure patterns
 *   5. Crash recovery and continuous uptime guarantees
 * 
 * Every issue is logged to Qdrant with full context so the system
 * learns from failures and prevents recurrence.
 */

import { execSync, spawn } from "child_process";
import { config } from "./config.js";
import { broadcast } from "./events.js";

// ── Types ──

export type IssueRecord = {
  id: string;
  timestamp: string;
  category: "port-conflict" | "hung-process" | "provider-failure" | "crash" | "rate-limit" | "qdrant-error" | "ollama-error" | "config-error";
  severity: "info" | "warning" | "critical";
  description: string;
  remediation: string;
  resolved: boolean;
  metadata: Record<string, unknown>;
};

type ProviderHealth = {
  name: string;
  consecutiveFailures: number;
  lastFailure: string | null;
  lastSuccess: string | null;
  disabled: boolean;
  disabledUntil: string | null;
  /** After cooldown, ramp up gradually: only allow 1-in-N requests through */
  recoveryMode: boolean;
  /** Fraction of requests allowed during recovery (0.0 to 1.0) */
  recoveryRate: number;
  /** Successful requests during recovery (resets to full health at threshold) */
  recoverySuccesses: number;
};

// ── State ──

const issues: IssueRecord[] = [];
const ISSUES_COLLECTION = "gateway_issues";
const MAX_MEMORY_ISSUES = 200;

function freshHealth(name: string): ProviderHealth {
  return {
    name, consecutiveFailures: 0, lastFailure: null, lastSuccess: null,
    disabled: false, disabledUntil: null,
    recoveryMode: false, recoveryRate: 1.0, recoverySuccesses: 0,
  };
}

const providerHealth: Record<string, ProviderHealth> = {
  openrouter: freshHealth("openrouter"),
  bedrock: freshHealth("bedrock"),
  ollama: freshHealth("ollama"),
};

// Circuit breaker thresholds
const CIRCUIT_BREAK_THRESHOLD = 5; // consecutive failures before temporary disable
const CIRCUIT_BREAK_COOLDOWN_MS = 5 * 60 * 1000; // 5 min cooldown
/** Successful requests needed during recovery to return to full health */
const RECOVERY_SUCCESS_THRESHOLD = 3;
/** Initial recovery rate after cooldown (25% of traffic) */
const RECOVERY_INITIAL_RATE = 0.25;

// ── Service Auto-Recovery ──

type ServiceState = {
  name: string;
  url: string;
  healthPath: string;
  lastCheck: number;
  lastUp: number;
  consecutiveDownChecks: number;
  restartAttempts: number;
  lastRestartAttempt: number;
  maxRestartAttempts: number;
  restartCooldownMs: number;
};

const serviceStates: Record<string, ServiceState> = {
  qdrant: {
    name: "qdrant",
    url: config.qdrantUrl || "http://127.0.0.1:6333",
    healthPath: "/collections",
    lastCheck: 0,
    lastUp: 0,
    consecutiveDownChecks: 0,
    restartAttempts: 0,
    lastRestartAttempt: 0,
    maxRestartAttempts: 3,
    restartCooldownMs: 5 * 60 * 1000,
  },
  ollama: {
    name: "ollama",
    url: config.ollamaHost || "http://127.0.0.1:11434",
    healthPath: "/api/tags",
    lastCheck: 0,
    lastUp: 0,
    consecutiveDownChecks: 0,
    restartAttempts: 0,
    lastRestartAttempt: 0,
    maxRestartAttempts: 3,
    restartCooldownMs: 5 * 60 * 1000,
  },
};

async function pingService(svc: ServiceState): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${svc.url}${svc.healthPath}`, { signal: controller.signal });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

async function restartService(svc: ServiceState): Promise<boolean> {
  const now = Date.now();
  const isWindows = process.platform === "win32";

  if (now - svc.lastRestartAttempt < svc.restartCooldownMs) return false;
  if (svc.restartAttempts >= svc.maxRestartAttempts) return false;

  svc.lastRestartAttempt = now;
  svc.restartAttempts++;

  console.log(`[self-healer] attempting to restart ${svc.name} (attempt ${svc.restartAttempts}/${svc.maxRestartAttempts})...`);

  try {
    if (svc.name === "ollama") {
      const ollamaPaths = isWindows
        ? [`${process.env.LOCALAPPDATA || "C:\\Users\\joewh\\AppData\\Local"}\\Programs\\Ollama\\ollama.exe`, "ollama"]
        : ["ollama"];
      for (const ollamaPath of ollamaPaths) {
        try {
          const child = spawn(ollamaPath, ["serve"], { detached: true, stdio: "ignore", shell: true });
          child.unref();
          await new Promise((r) => setTimeout(r, 5000));
          if (await pingService(svc)) {
            await logIssue("ollama-error", "info",
              `Ollama auto-restarted successfully (attempt ${svc.restartAttempts})`,
              `Service restored at ${svc.url}`, { path: ollamaPath, attempt: svc.restartAttempts }, true);
            svc.consecutiveDownChecks = 0;
            svc.lastUp = Date.now();
            return true;
          }
        } catch { /* try next path */ }
      }
    }

    if (svc.name === "qdrant") {
      // Try native binary first (preferred), then Docker fallback
      const qdrantPaths = isWindows
        ? [
            `${process.env.USERPROFILE || "C:\\Users\\joewh"}\\ai-cache\\qdrant-bin\\qdrant.exe`,
            "qdrant",
          ]
        : ["qdrant"];
      const configPath = isWindows
        ? `${process.env.USERPROFILE || "C:\\Users\\joewh"}\\ai-cache\\qdrant-bin\\config.yaml`
        : "";
      let nativeStarted = false;
      for (const qdrantPath of qdrantPaths) {
        try {
          const args = configPath ? ["--config-path", configPath] : [];
          const child = spawn(qdrantPath, args, { detached: true, stdio: "ignore", shell: true });
          child.unref();
          await new Promise((r) => setTimeout(r, 8000));
          if (await pingService(svc)) {
            await logIssue("qdrant-error", "info",
              `Qdrant auto-restarted via native binary (attempt ${svc.restartAttempts})`,
              `Service restored at ${svc.url}`, { path: qdrantPath, attempt: svc.restartAttempts }, true);
            svc.consecutiveDownChecks = 0;
            svc.lastUp = Date.now();
            nativeStarted = true;
            return true;
          }
        } catch { /* try next path */ }
      }
      // Docker fallback if native binary not available or failed
      if (!nativeStarted) {
        try {
          execSync("docker info", { timeout: 10000, stdio: "pipe" });
          const containers = execSync('docker ps -a --filter name=qdrant --format "{{.Names}}:{{.Status}}"', {
            encoding: "utf8", timeout: 5000,
          }).trim();
          if (containers.includes("qdrant")) {
            execSync("docker start qdrant", { timeout: 15000 });
          } else {
            execSync(
              "docker run -d --name qdrant -p 6333:6333 -p 6334:6334 -v qdrant_storage:/qdrant/storage qdrant/qdrant",
              { timeout: 60000 },
            );
          }
          await new Promise((r) => setTimeout(r, 8000));
          if (await pingService(svc)) {
            await logIssue("qdrant-error", "info",
              `Qdrant auto-restarted via Docker`, `Service restored at ${svc.url}`,
              { method: containers.includes("qdrant") ? "docker start" : "docker run" }, true);
            svc.consecutiveDownChecks = 0;
            svc.lastUp = Date.now();
            return true;
          }
        } catch (dockerErr) {
          console.log(`[self-healer] Docker fallback also failed for Qdrant: ${(dockerErr as Error).message?.slice(0, 80)}`);
        }
      }
    }

    await logIssue(
      svc.name === "qdrant" ? "qdrant-error" : "ollama-error", "warning",
      `Failed to auto-restart ${svc.name} (attempt ${svc.restartAttempts}/${svc.maxRestartAttempts})`,
      svc.restartAttempts >= svc.maxRestartAttempts
        ? "Max restart attempts reached. Manual intervention required."
        : `Will retry after ${svc.restartCooldownMs / 1000}s cooldown.`,
      { attempt: svc.restartAttempts }, false);
    return false;
  } catch (err) {
    console.warn(`[self-healer] restart ${svc.name} error: ${(err as Error).message}`);
    return false;
  }
}

async function checkServiceHealth(): Promise<void> {
  for (const svc of Object.values(serviceStates)) {
    svc.lastCheck = Date.now();
    const up = await pingService(svc);
    if (up) {
      if (svc.consecutiveDownChecks > 0) {
        console.log(`[self-healer] ${svc.name} recovered (was down for ${svc.consecutiveDownChecks} checks)`);
        svc.restartAttempts = 0;
      }
      svc.consecutiveDownChecks = 0;
      svc.lastUp = Date.now();
    } else {
      svc.consecutiveDownChecks++;
      if (svc.consecutiveDownChecks >= 2) {
        await restartService(svc);
      }
    }
  }
}

export function getServiceStates(): Record<string, ServiceState> {
  return { ...serviceStates };
}

// ── Qdrant Issues Store ──

async function ensureIssuesCollection(): Promise<void> {
  try {
    // Simple collection — no vectors, just payload storage for issue logs
    const check = await fetch(`${config.qdrantUrl}/collections/${ISSUES_COLLECTION}`);
    if (check.ok) return; // already exists

    await fetch(`${config.qdrantUrl}/collections/${ISSUES_COLLECTION}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vectors: { size: 4, distance: "Cosine" }, // minimal vector (Qdrant requires one)
      }),
    });
    console.log("[self-healer] created issues collection in Qdrant");
  } catch (err) {
    console.warn("[self-healer] could not create issues collection:", (err as Error).message);
  }
}

function issueToUUID(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash) + id.charCodeAt(i);
    hash = hash & hash;
  }
  let hash2 = 5381;
  for (let i = 0; i < id.length; i++) {
    hash2 = ((hash2 << 5) + hash2) + id.charCodeAt(i);
    hash2 = hash2 & hash2;
  }
  const hex = Math.abs(hash).toString(16).padStart(8, "0");
  const hex2 = Math.abs(hash2).toString(16).padStart(8, "0");
  return `${hex.slice(0, 8)}-${hex.slice(0, 4)}-4${hex.slice(1, 4)}-8${hex2.slice(0, 3)}-${hex2.padEnd(12, "0").slice(0, 12)}`;
}

async function persistIssue(issue: IssueRecord): Promise<void> {
  try {
    await fetch(`${config.qdrantUrl}/collections/${ISSUES_COLLECTION}/points?wait=true`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        points: [{
          id: issueToUUID(issue.id),
          vector: [0.1, 0.1, 0.1, 0.1], // dummy vector
          payload: {
            ...issue,
            metadata: JSON.stringify(issue.metadata),
          },
        }],
      }),
    });
  } catch {
    // Best effort — don't let issue logging crash the healer
  }
}

async function queryRecentIssues(category?: string, limit = 20): Promise<IssueRecord[]> {
  try {
    const filter: any = {};
    if (category) {
      filter.must = [{ key: "category", match: { value: category } }];
    }

    const res = await fetch(`${config.qdrantUrl}/collections/${ISSUES_COLLECTION}/points/scroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filter: Object.keys(filter).length ? filter : undefined,
        limit,
        with_payload: true,
      }),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as any;
    return (data.result?.points ?? []).map((p: any) => ({
      ...p.payload,
      metadata: typeof p.payload.metadata === "string" ? JSON.parse(p.payload.metadata) : p.payload.metadata,
    }));
  } catch {
    return [];
  }
}

// ── Core Issue Tracking ──

export async function logIssue(
  category: IssueRecord["category"],
  severity: IssueRecord["severity"],
  description: string,
  remediation: string,
  metadata: Record<string, unknown> = {},
  resolved = false,
): Promise<IssueRecord> {
  const issue: IssueRecord = {
    id: `${category}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toISOString(),
    category,
    severity,
    description,
    remediation,
    resolved,
    metadata,
  };

  // In-memory ring buffer
  issues.push(issue);
  if (issues.length > MAX_MEMORY_ISSUES) issues.shift();

  // Persist to Qdrant
  await persistIssue(issue);

  // Broadcast to SSE clients
  broadcast("self-healer:issue", {
    category: issue.category,
    severity: issue.severity,
    description: issue.description,
    remediation: issue.remediation,
    resolved: issue.resolved,
  });

  console.log(`[self-healer] ${severity.toUpperCase()}: ${description} → ${remediation}`);
  return issue;
}

// ── Port Conflict Resolution ──

export async function resolvePortConflict(port: number): Promise<boolean> {
  const isWindows = process.platform === "win32";

  try {
    if (isWindows) {
      // Find PID holding the port
      const result = execSync(`netstat -ano | findstr :${port} | findstr LISTEN`, {
        encoding: "utf8",
        timeout: 5000,
      }).trim();

      if (!result) return true; // port is free

      const lines = result.split("\n");
      const pids = new Set<number>();
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        const pid = parseInt(parts[parts.length - 1], 10);
        if (pid && pid !== process.pid) pids.add(pid);
      }

      if (pids.size === 0) return true;

      for (const pid of pids) {
        try {
          // Get process name for logging
          let procName = "unknown";
          try {
            procName = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, {
              encoding: "utf8",
              timeout: 3000,
            }).trim().split(",")[0]?.replace(/"/g, "") ?? "unknown";
          } catch { /* silent */ }

          execSync(`taskkill /PID ${pid} /F`, { timeout: 5000 });

          await logIssue(
            "port-conflict",
            "warning",
            `Port ${port} was held by PID ${pid} (${procName})`,
            `Killed PID ${pid} to free port ${port}`,
            { pid, port, processName: procName },
            true,
          );
        } catch (err) {
          await logIssue(
            "port-conflict",
            "critical",
            `Failed to kill PID ${pid} holding port ${port}`,
            `Manual intervention may be needed: taskkill /PID ${pid} /F`,
            { pid, port, error: (err as Error).message },
            false,
          );
          return false;
        }
      }

      // Wait for port to actually free up
      await new Promise((r) => setTimeout(r, 1000));
      return true;
    } else {
      // Linux/Mac
      const result = execSync(`lsof -ti :${port}`, { encoding: "utf8", timeout: 5000 }).trim();
      if (!result) return true;
      for (const pidStr of result.split("\n")) {
        const pid = parseInt(pidStr, 10);
        if (pid && pid !== process.pid) {
          execSync(`kill -9 ${pid}`, { timeout: 3000 });
          await logIssue("port-conflict", "warning",
            `Port ${port} was held by PID ${pid}`,
            `Killed PID ${pid}`, { pid, port }, true);
        }
      }
      await new Promise((r) => setTimeout(r, 500));
      return true;
    }
  } catch (err) {
    // netstat/lsof returned nothing = port is free
    if ((err as any)?.status === 1) return true;
    console.warn(`[self-healer] port check failed: ${(err as Error).message}`);
    return true; // assume free and let Express fail if not
  }
}

// ── Provider Health & Circuit Breaker ──

export function reportProviderSuccess(provider: string): void {
  const health = providerHealth[provider];
  if (!health) return;
  health.consecutiveFailures = 0;
  health.lastSuccess = new Date().toISOString();

  if (health.disabled) {
    // Shouldn't happen — disabled providers don't get requests
    health.disabled = false;
    health.disabledUntil = null;
    health.recoveryMode = false;
    health.recoveryRate = 1.0;
    health.recoverySuccesses = 0;
    console.log(`[self-healer] provider ${provider} re-enabled after success`);
  } else if (health.recoveryMode) {
    // Gradual ramp-up: count successes during recovery
    health.recoverySuccesses++;
    if (health.recoverySuccesses >= RECOVERY_SUCCESS_THRESHOLD) {
      // Graduated to full health
      health.recoveryMode = false;
      health.recoveryRate = 1.0;
      health.recoverySuccesses = 0;
      console.log(`[self-healer] provider ${provider} fully recovered after ${RECOVERY_SUCCESS_THRESHOLD} successes`);
    } else {
      // Ramp up: 25% → 50% → 75% → 100%
      health.recoveryRate = Math.min(1.0, RECOVERY_INITIAL_RATE + (health.recoverySuccesses / RECOVERY_SUCCESS_THRESHOLD) * (1.0 - RECOVERY_INITIAL_RATE));
      console.log(`[self-healer] provider ${provider} recovery: ${Math.round(health.recoveryRate * 100)}% traffic (${health.recoverySuccesses}/${RECOVERY_SUCCESS_THRESHOLD} successes)`);
    }
  }
}

export async function reportProviderFailure(provider: string, error: string): Promise<void> {
  const health = providerHealth[provider];
  if (!health) return;
  health.consecutiveFailures++;
  health.lastFailure = new Date().toISOString();

  // Circuit breaker: disable provider after N consecutive failures
  if (health.consecutiveFailures >= CIRCUIT_BREAK_THRESHOLD && !health.disabled) {
    health.disabled = true;
    health.disabledUntil = new Date(Date.now() + CIRCUIT_BREAK_COOLDOWN_MS).toISOString();

    await logIssue(
      "provider-failure",
      "warning",
      `Provider ${provider} circuit-broken after ${health.consecutiveFailures} consecutive failures`,
      `Disabled for ${CIRCUIT_BREAK_COOLDOWN_MS / 1000}s. Last error: ${error.slice(0, 150)}`,
      { provider, failures: health.consecutiveFailures, lastError: error },
      false,
    );
  }
}

export function isProviderAvailable(provider: string): boolean {
  const health = providerHealth[provider];
  if (!health) return true;

  // Fully healthy
  if (!health.disabled && !health.recoveryMode) return true;

  // In recovery mode — probabilistic gating
  if (!health.disabled && health.recoveryMode) {
    return Math.random() < health.recoveryRate;
  }

  // Check if cooldown has expired → enter recovery mode (not instant full health)
  if (health.disabled && health.disabledUntil && new Date() > new Date(health.disabledUntil)) {
    health.disabled = false;
    health.disabledUntil = null;
    health.consecutiveFailures = 0;
    // Enter recovery mode instead of instant full health
    health.recoveryMode = true;
    health.recoveryRate = RECOVERY_INITIAL_RATE;
    health.recoverySuccesses = 0;
    console.log(`[self-healer] provider ${provider} cooldown expired, entering recovery mode (${Math.round(RECOVERY_INITIAL_RATE * 100)}% traffic)`);
    return Math.random() < health.recoveryRate;
  }

  return false;
}

// ── Hung Process Detection ──

const activeRequests = new Map<string, { startedAt: number; provider: string; timeoutMs: number }>();

export function trackRequest(id: string, provider: string, timeoutMs = 30_000): void {
  activeRequests.set(id, { startedAt: Date.now(), provider, timeoutMs });
}

export function completeRequest(id: string): void {
  activeRequests.delete(id);
}

export async function checkHungRequests(): Promise<number> {
  const now = Date.now();
  let hungCount = 0;

  for (const [id, req] of activeRequests) {
    if (now - req.startedAt > req.timeoutMs) {
      hungCount++;
      activeRequests.delete(id);

      await logIssue(
        "hung-process",
        "warning",
        `LLM request ${id} to ${req.provider} hung for ${Math.round((now - req.startedAt) / 1000)}s`,
        `Request removed from tracking. Provider ${req.provider} may need circuit-breaking.`,
        { requestId: id, provider: req.provider, durationMs: now - req.startedAt },
        true,
      );

      await reportProviderFailure(req.provider, `Hung request after ${now - req.startedAt}ms`);
    }
  }

  return hungCount;
}

// ── Startup Self-Check ──

export async function runStartupChecks(port: number): Promise<void> {
  console.log("[self-healer] running startup checks...");

  // 1. Resolve port conflicts
  const portFree = await resolvePortConflict(port);
  if (!portFree) {
    console.error(`[self-healer] CRITICAL: could not free port ${port}`);
  }

  // 2. Ensure Qdrant issues collection
  await ensureIssuesCollection();

  // 3. Check provider availability — full reset on fresh startup
  for (const [name, health] of Object.entries(providerHealth)) {
    health.disabled = false;
    health.disabledUntil = null;
    health.consecutiveFailures = 0;
    health.recoveryMode = false;
    health.recoveryRate = 1.0;
    health.recoverySuccesses = 0;
  }

  // 4. Check Qdrant connectivity
  try {
    const res = await fetch(`${config.qdrantUrl}/collections`);
    if (!res.ok) throw new Error(`Qdrant ${res.status}`);
    console.log("[self-healer] Qdrant connected");
  } catch (err) {
    await logIssue(
      "qdrant-error",
      "warning",
      `Qdrant not reachable at ${config.qdrantUrl}`,
      "Knowledge and issue tracking degraded. Start Qdrant manually.",
      { url: config.qdrantUrl, error: (err as Error).message },
      false,
    );
  }

  // 5. Check Ollama for embeddings
  try {
    const res = await fetch(`${config.ollamaHost}/api/tags`);
    if (!res.ok) throw new Error(`Ollama ${res.status}`);
    console.log("[self-healer] Ollama connected");
  } catch (err) {
    await logIssue(
      "ollama-error",
      "warning",
      `Ollama not reachable at ${config.ollamaHost}`,
      "Embedding and knowledge ingestion degraded. Start Ollama manually.",
      { url: config.ollamaHost, error: (err as Error).message },
      false,
    );
  }

  // 6. Load historical issues for pattern detection
  const recentIssues = await queryRecentIssues(undefined, 50);
  if (recentIssues.length > 0) {
    const byCategory = recentIssues.reduce((acc, i) => {
      acc[i.category] = (acc[i.category] ?? 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    console.log(`[self-healer] historical issues: ${JSON.stringify(byCategory)}`);
  }

  console.log("[self-healer] startup checks complete");
}

// ── Runtime Watchdog ──

let watchdogTimer: NodeJS.Timeout | null = null;

export function startWatchdog(intervalMs = 30_000): void {
  if (watchdogTimer) return;

  watchdogTimer = setInterval(async () => {
    // Check for hung requests
    const hung = await checkHungRequests();
    if (hung > 0) {
      console.log(`[self-healer] watchdog found ${hung} hung requests`);
    }

    // Re-enable circuit-broken providers if cooldown expired → recovery mode
    for (const health of Object.values(providerHealth)) {
      if (health.disabled && health.disabledUntil && new Date() > new Date(health.disabledUntil)) {
        health.disabled = false;
        health.disabledUntil = null;
        health.consecutiveFailures = 0;
        health.recoveryMode = true;
        health.recoveryRate = RECOVERY_INITIAL_RATE;
        health.recoverySuccesses = 0;
        console.log(`[self-healer] watchdog: ${health.name} → recovery mode (${Math.round(RECOVERY_INITIAL_RATE * 100)}% traffic)`);
      }
    }

    // Check infrastructure services (Qdrant, Ollama) and auto-restart if down
    await checkServiceHealth();
  }, intervalMs);

  console.log(`[self-healer] watchdog started (${intervalMs}ms interval)`);
}

export function stopWatchdog(): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}

// ── API Accessors ──

export function getIssues(limit = 50): IssueRecord[] {
  return issues.slice(-limit);
}

export function getProviderHealth(): Record<string, ProviderHealth> {
  return { ...providerHealth };
}

export function getHealerStats(): {
  totalIssues: number;
  byCategory: Record<string, number>;
  providerHealth: Record<string, ProviderHealth>;
  activeRequests: number;
} {
  const byCategory = issues.reduce((acc, i) => {
    acc[i.category] = (acc[i.category] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  return {
    totalIssues: issues.length,
    byCategory,
    providerHealth: { ...providerHealth },
    activeRequests: activeRequests.size,
  };
}
