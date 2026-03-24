/**
 * OpenRouter LLM client — free/cheap model access via OpenRouter API.
 * Compatible interface with bedrock.ts for drop-in provider switching.
 *
 * Rate-limit aware: uses rate-limiter.ts pacer to stay within free tier
 * limits instead of slamming until 429. Retries only on genuine transient
 * errors (502/503), not on rate limits (handled by the pacer).
 *
 * Free models: mistralai/mistral-small-3.1-24b-instruct:free,
 * meta-llama/llama-3.3-70b-instruct:free, google/gemma-3-12b-it:free
 */

import { config } from "./config.js";
import { reportProviderSuccess, reportProviderFailure, isProviderAvailable } from "./self-healer.js";
import {
  waitForSlot,
  recordRequest,
  parseRateLimitHeaders,
  record429,
  recordUsage,
} from "./rate-limiter.js";

const OPENROUTER_API = "https://openrouter.ai/api/v1/chat/completions";
/** Only retry on 502/503 upstream errors — 429s are handled by the pacer */
const MAX_UPSTREAM_RETRIES = 2;
const UPSTREAM_BACKOFF_MS = 3000;

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function callOpenRouter(
  system: string,
  user: string,
  opts?: { temp?: number; maxTokens?: number; model?: string }
): Promise<string> {
  const apiKey = config.openrouterApiKey;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY not configured");
  if (!isProviderAvailable("openrouter")) {
    throw new Error("OpenRouter circuit-broken (too many failures)");
  }

  const model = opts?.model ?? config.openrouterModel;

  // ── Pace: wait for a free slot before sending ──
  await waitForSlot();

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_UPSTREAM_RETRIES; attempt++) {
    if (attempt > 0) {
      const backoff = UPSTREAM_BACKOFF_MS * attempt;
      console.log(`[openrouter] upstream retry ${attempt}/${MAX_UPSTREAM_RETRIES} after ${backoff}ms...`);
      await sleep(backoff);
    }

    const start = Date.now();
    try {
      const res = await fetch(OPENROUTER_API, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "HTTP-Referer": "http://localhost:4123",
          "X-Title": "local-devops-ai",
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          max_tokens: opts?.maxTokens ?? config.maxTokens,
          temperature: opts?.temp ?? config.temperature,
        }),
      });

      // Record that we made a request (for pacing calculations)
      recordRequest("openrouter");

      // Always parse rate-limit headers, even on errors
      parseRateLimitHeaders(res.headers);

      // ── 429: Don't retry here — record cooldown and throw.
      // The caller (agent.ts) will use recommendProvider() to route elsewhere.
      if (res.status === 429) {
        const retryAfter = res.headers.get("retry-after");
        record429(retryAfter);
        const body = await res.text().catch(() => "");
        throw new Error(`OpenRouter 429 (rate limited): ${body.slice(0, 150)}`);
      }

      // 502/503: upstream overload — worth retrying
      if (res.status === 502 || res.status === 503) {
        const body = await res.text().catch(() => "");
        lastError = new Error(`OpenRouter ${res.status}: ${body.slice(0, 150)}`);
        console.warn(`[openrouter] ${res.status} on attempt ${attempt + 1}: ${body.slice(0, 100)}`);
        continue;
      }

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`OpenRouter ${res.status}: ${body.slice(0, 200)}`);
      }

      const data = (await res.json()) as any;
      const text = data.choices?.[0]?.message?.content ?? "";
      const tokUsage = data.usage;
      const elapsed = Date.now() - start;

      const promptTokens = tokUsage?.prompt_tokens ?? 0;
      const completionTokens = tokUsage?.completion_tokens ?? 0;

      console.log(
        `[openrouter] ${model} | ${promptTokens}in/${completionTokens}out | ${elapsed}ms`
      );

      // Track usage in the rate-limiter ledger
      recordUsage("openrouter", promptTokens, completionTokens);
      reportProviderSuccess("openrouter");
      return text;
    } catch (err) {
      lastError = err as Error;
      const msg = (err as Error).message ?? "";
      // Only retry on 502/503 upstream errors
      if (msg.includes("502") || msg.includes("503")) {
        continue;
      }
      // Everything else (429, 4xx, network) — throw immediately
      // 429s are NOT retried here; the pacer + smart routing handles them
      throw err;
    }
  }

  // All upstream retries exhausted (502/503 only)
  const errMsg = lastError?.message ?? "all retries exhausted";
  reportProviderFailure("openrouter", errMsg).catch(() => {});
  throw lastError ?? new Error("OpenRouter: upstream retries exhausted");
}
