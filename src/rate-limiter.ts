/**
 * Rate Limit Intelligence — centralized request pacer and cost tracker.
 *
 * Instead of slamming OpenRouter until 429 and falling back to paid Bedrock,
 * this module:
 *   1. Tracks OpenRouter rate-limit headers (RPM, remaining, reset)
 *   2. Paces requests to stay within limits (adaptive delay between calls)
 *   3. Provides a pre-flight check before every LLM call
 *   4. Tracks token usage and estimated cost per provider
 *   5. Routes intelligently: queue/delay for free, skip to Ollama CPU
 *      instead of burning Bedrock when OpenRouter is throttled
 *
 * Key insight: OpenRouter free tier is ~20 RPM. An agent run makes ~15 calls.
 * Without pacing, all 15 hit in <30s → 429 storm → Bedrock fallback cascade.
 * With pacing at 1 req/3s, the run takes ~45s but stays 100% free.
 */

// ── Types ──

export type ProviderName = "openrouter" | "bedrock" | "ollama";

type RateLimitState = {
  /** Requests per minute limit (from headers or configured default) */
  rpm: number;
  /** Remaining requests in current window */
  remaining: number;
  /** When the rate limit window resets (epoch ms) */
  resetsAt: number;
  /** Timestamp of last successful request */
  lastRequestAt: number;
  /** Minimum ms between requests (derived from RPM) */
  minIntervalMs: number;
  /** Whether we're currently in a cooldown from a 429 */
  inCooldown: boolean;
  /** When cooldown expires */
  cooldownUntil: number;
};

type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  requests: number;
  /** Estimated cost in USD (0 for free models) */
  estimatedCostUsd: number;
};

type UsageWindow = {
  hourly: TokenUsage;
  daily: TokenUsage;
  hourResetAt: number;
  dayResetAt: number;
};

export type RateLimiterStats = {
  openrouter: {
    rateLimit: RateLimitState;
    usage: UsageWindow;
    /** Recommended delay before next request (ms) */
    recommendedDelayMs: number;
    /** Whether requests should be paused entirely */
    paused: boolean;
    pauseReason?: string;
  };
  bedrock: {
    usage: UsageWindow;
  };
  ollama: {
    usage: UsageWindow;
  };
  /** Provider recommendation for next call */
  recommendation: {
    provider: ProviderName;
    reason: string;
    delayMs: number;
  };
};

// ── Constants ──

/** OpenRouter free tier default RPM (conservative estimate) */
const DEFAULT_FREE_RPM = 20;

/** Minimum spacing between OpenRouter requests (ms).
 *  3.5s = ~17 RPM — safely under 20 RPM with buffer */
const DEFAULT_MIN_INTERVAL_MS = 3500;

/** After a 429, back off for this long before retrying (ms) */
const COOLDOWN_AFTER_429_MS = 30_000;

/** Max Bedrock spend per hour before preferring Ollama (USD) */
const MAX_BEDROCK_HOURLY_USD = 0.50;

/** Max Bedrock spend per day before preferring Ollama (USD) */
const MAX_BEDROCK_DAILY_USD = 5.00;

/** Bedrock Llama 3.1 8B pricing (per 1K tokens, approx) */
const BEDROCK_COST_PER_1K_INPUT = 0.0003;
const BEDROCK_COST_PER_1K_OUTPUT = 0.0006;

// ── State ──

const rateLimitState: RateLimitState = {
  rpm: DEFAULT_FREE_RPM,
  remaining: DEFAULT_FREE_RPM,
  resetsAt: 0,
  lastRequestAt: 0,
  minIntervalMs: DEFAULT_MIN_INTERVAL_MS,
  inCooldown: false,
  cooldownUntil: 0,
};

function freshUsage(): TokenUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, requests: 0, estimatedCostUsd: 0 };
}

function freshWindow(): UsageWindow {
  const now = Date.now();
  return {
    hourly: freshUsage(),
    daily: freshUsage(),
    hourResetAt: now + 3600_000,
    dayResetAt: now + 86400_000,
  };
}

const usage: Record<ProviderName, UsageWindow> = {
  openrouter: freshWindow(),
  bedrock: freshWindow(),
  ollama: freshWindow(),
};

// ── Window Reset ──

function maybeResetWindows(provider: ProviderName): void {
  const now = Date.now();
  const w = usage[provider];
  if (now >= w.hourResetAt) {
    w.hourly = freshUsage();
    w.hourResetAt = now + 3600_000;
  }
  if (now >= w.dayResetAt) {
    w.daily = freshUsage();
    w.dayResetAt = now + 86400_000;
  }
}

// ── Public API ──

/**
 * Pre-flight check: should we send a request to OpenRouter now?
 * Returns { canSend, delayMs, reason }.
 * If canSend is false, delayMs tells you how long to wait.
 */
export function preflightCheck(): { canSend: boolean; delayMs: number; reason: string } {
  const now = Date.now();

  // Check cooldown (from a recent 429)
  if (rateLimitState.inCooldown) {
    if (now < rateLimitState.cooldownUntil) {
      const wait = rateLimitState.cooldownUntil - now;
      return { canSend: false, delayMs: wait, reason: `429 cooldown (${Math.ceil(wait / 1000)}s remaining)` };
    }
    // Cooldown expired
    rateLimitState.inCooldown = false;
  }

  // Check remaining quota from headers
  if (rateLimitState.remaining <= 1 && now < rateLimitState.resetsAt) {
    const wait = rateLimitState.resetsAt - now;
    return { canSend: false, delayMs: wait, reason: `RPM exhausted, resets in ${Math.ceil(wait / 1000)}s` };
  }

  // Enforce minimum spacing between requests
  const elapsed = now - rateLimitState.lastRequestAt;
  if (elapsed < rateLimitState.minIntervalMs) {
    const wait = rateLimitState.minIntervalMs - elapsed;
    return { canSend: false, delayMs: wait, reason: `pacing (${wait}ms until next slot)` };
  }

  return { canSend: true, delayMs: 0, reason: "ok" };
}

/**
 * Wait until we're clear to send an OpenRouter request.
 * This is the primary integration point — call this before every OpenRouter call.
 * Returns immediately if no delay needed, otherwise sleeps the right amount.
 */
export async function waitForSlot(): Promise<void> {
  const check = preflightCheck();
  if (check.canSend) return;

  console.log(`[rate-limiter] pacing: ${check.reason}`);
  await new Promise((r) => setTimeout(r, check.delayMs));

  // Re-check after wait (recursive, but max 2 levels in practice)
  const recheck = preflightCheck();
  if (!recheck.canSend) {
    await new Promise((r) => setTimeout(r, recheck.delayMs));
  }
}

/**
 * Record that we just sent a request to OpenRouter.
 * Call this AFTER fetch() completes (even on error).
 */
export function recordRequest(provider: ProviderName): void {
  if (provider === "openrouter") {
    rateLimitState.lastRequestAt = Date.now();
    if (rateLimitState.remaining > 0) {
      rateLimitState.remaining--;
    }
  }
}

/**
 * Parse rate-limit headers from OpenRouter's response.
 * Headers we care about:
 *   x-ratelimit-limit-requests: 20
 *   x-ratelimit-remaining-requests: 15
 *   x-ratelimit-reset-requests: 3s
 */
export function parseRateLimitHeaders(headers: Headers): void {
  const limitStr = headers.get("x-ratelimit-limit-requests");
  const remainStr = headers.get("x-ratelimit-remaining-requests");
  const resetStr = headers.get("x-ratelimit-reset-requests");

  if (limitStr) {
    const limit = parseInt(limitStr, 10);
    if (!isNaN(limit) && limit > 0) {
      rateLimitState.rpm = limit;
      // Derive min interval: (60s / RPM) * 1000, with 20% safety margin
      rateLimitState.minIntervalMs = Math.max(1000, Math.ceil((60_000 / limit) * 1.2));
    }
  }

  if (remainStr) {
    const remaining = parseInt(remainStr, 10);
    if (!isNaN(remaining)) {
      rateLimitState.remaining = remaining;
    }
  }

  if (resetStr) {
    // Format: "3s" or "1m30s" or "45s"
    const seconds = parseResetDuration(resetStr);
    if (seconds > 0) {
      rateLimitState.resetsAt = Date.now() + seconds * 1000;
      // Also refill remaining when reset happens
      if (rateLimitState.remaining <= 0) {
        rateLimitState.remaining = rateLimitState.rpm;
      }
    }
  }
}

/** Parse OpenRouter reset duration string like "3s", "1m30s", "500ms" */
function parseResetDuration(s: string): number {
  let totalSeconds = 0;
  const minMatch = s.match(/(\d+)m/);
  const secMatch = s.match(/(\d+)s/);
  const msMatch = s.match(/(\d+)ms/);
  if (minMatch) totalSeconds += parseInt(minMatch[1], 10) * 60;
  if (secMatch && !msMatch) totalSeconds += parseInt(secMatch[1], 10);
  if (msMatch) totalSeconds += parseInt(msMatch[1], 10) / 1000;
  return totalSeconds || 0;
}

/**
 * Record a 429 response — enter cooldown mode.
 * Extracts retry-after if available.
 */
export function record429(retryAfterHeader?: string | null): void {
  let cooldownMs = COOLDOWN_AFTER_429_MS;
  if (retryAfterHeader) {
    const secs = parseFloat(retryAfterHeader);
    if (!isNaN(secs) && secs > 0) {
      cooldownMs = Math.max(secs * 1000, 5000); // at least 5s
    }
  }
  rateLimitState.inCooldown = true;
  rateLimitState.cooldownUntil = Date.now() + cooldownMs;
  rateLimitState.remaining = 0;
  console.log(`[rate-limiter] 429 received — cooldown for ${Math.ceil(cooldownMs / 1000)}s`);
}

/**
 * Record token usage for a provider.
 */
export function recordUsage(
  provider: ProviderName,
  promptTokens: number,
  completionTokens: number,
): void {
  maybeResetWindows(provider);
  const w = usage[provider];

  const update = (u: TokenUsage) => {
    u.promptTokens += promptTokens;
    u.completionTokens += completionTokens;
    u.totalTokens += promptTokens + completionTokens;
    u.requests++;

    if (provider === "bedrock") {
      u.estimatedCostUsd +=
        (promptTokens / 1000) * BEDROCK_COST_PER_1K_INPUT +
        (completionTokens / 1000) * BEDROCK_COST_PER_1K_OUTPUT;
    }
    // OpenRouter free = $0, Ollama local = $0
  };

  update(w.hourly);
  update(w.daily);
}

/**
 * Smart provider recommendation — which provider should the next call use?
 * Returns the best provider and any delay needed.
 */
export function recommendProvider(): { provider: ProviderName; reason: string; delayMs: number } {
  // 1. Can we use OpenRouter right now?
  const orCheck = preflightCheck();
  if (orCheck.canSend) {
    return { provider: "openrouter", reason: "free slot available", delayMs: 0 };
  }

  // 2. If OpenRouter needs a short wait (< 10s), just wait — it's free
  if (orCheck.delayMs <= 10_000) {
    return { provider: "openrouter", reason: `wait ${Math.ceil(orCheck.delayMs / 1000)}s for free slot`, delayMs: orCheck.delayMs };
  }

  // 3. OpenRouter blocked for a while — check Bedrock budget
  maybeResetWindows("bedrock");
  const bedrockHourly = usage.bedrock.hourly.estimatedCostUsd;
  const bedrockDaily = usage.bedrock.daily.estimatedCostUsd;

  if (bedrockHourly < MAX_BEDROCK_HOURLY_USD && bedrockDaily < MAX_BEDROCK_DAILY_USD) {
    return {
      provider: "bedrock",
      reason: `OpenRouter blocked ${Math.ceil(orCheck.delayMs / 1000)}s, Bedrock within budget ($${bedrockHourly.toFixed(3)}/hr, $${bedrockDaily.toFixed(3)}/day)`,
      delayMs: 0,
    };
  }

  // 4. Bedrock over budget — check if OpenRouter wait is bearable (< 60s)
  if (orCheck.delayMs <= 60_000) {
    return {
      provider: "openrouter",
      reason: `Bedrock over budget ($${bedrockHourly.toFixed(2)}/hr), waiting ${Math.ceil(orCheck.delayMs / 1000)}s for free slot`,
      delayMs: orCheck.delayMs,
    };
  }

  // 5. Everything expensive/blocked — fall back to Ollama CPU
  return {
    provider: "ollama",
    reason: `OpenRouter blocked ${Math.ceil(orCheck.delayMs / 1000)}s, Bedrock over budget ($${bedrockDaily.toFixed(2)}/day)`,
    delayMs: 0,
  };
}

/**
 * Get full stats for the /llm/usage endpoint.
 */
export function getStats(): RateLimiterStats {
  for (const p of ["openrouter", "bedrock", "ollama"] as ProviderName[]) {
    maybeResetWindows(p);
  }

  const rec = recommendProvider();
  const check = preflightCheck();

  return {
    openrouter: {
      rateLimit: { ...rateLimitState },
      usage: { ...usage.openrouter },
      recommendedDelayMs: check.delayMs,
      paused: !check.canSend,
      pauseReason: check.canSend ? undefined : check.reason,
    },
    bedrock: {
      usage: { ...usage.bedrock },
    },
    ollama: {
      usage: { ...usage.ollama },
    },
    recommendation: rec,
  };
}

/**
 * Reset all state (for testing or manual override).
 */
export function resetRateLimiter(): void {
  rateLimitState.rpm = DEFAULT_FREE_RPM;
  rateLimitState.remaining = DEFAULT_FREE_RPM;
  rateLimitState.resetsAt = 0;
  rateLimitState.lastRequestAt = 0;
  rateLimitState.minIntervalMs = DEFAULT_MIN_INTERVAL_MS;
  rateLimitState.inCooldown = false;
  rateLimitState.cooldownUntil = 0;

  for (const p of ["openrouter", "bedrock", "ollama"] as ProviderName[]) {
    usage[p] = freshWindow();
  }
}
