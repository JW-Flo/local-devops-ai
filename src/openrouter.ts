/**
 * OpenRouter LLM client — free/cheap model access via OpenRouter API.
 * Compatible interface with bedrock.ts for drop-in provider switching.
 * 
 * Includes retry-with-backoff for 429 rate limits (free tier).
 * Free models: mistralai/mistral-small-3.1-24b-instruct:free,
 * meta-llama/llama-3.3-70b-instruct:free, google/gemma-3-12b-it:free
 */

import { config } from "./config.js";
import { reportProviderSuccess, reportProviderFailure, isProviderAvailable } from "./self-healer.js";

const OPENROUTER_API = "https://openrouter.ai/api/v1/chat/completions";
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 2000;

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
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt - 1);
      console.log(`[openrouter] retry ${attempt}/${MAX_RETRIES} after ${backoff}ms...`);
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

      // Retry on 429 (rate limit) and 502/503 (upstream overload)
      if (res.status === 429 || res.status === 502 || res.status === 503) {
        const body = await res.text().catch(() => "");
        lastError = new Error(`OpenRouter ${res.status}: ${body.slice(0, 150)}`);
        console.warn(`[openrouter] ${res.status} on attempt ${attempt + 1}: ${body.slice(0, 100)}`);
        continue; // retry
      }

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`OpenRouter ${res.status}: ${body.slice(0, 200)}`);
      }

      const data = (await res.json()) as any;
      const text = data.choices?.[0]?.message?.content ?? "";
      const usage = data.usage;
      const elapsed = Date.now() - start;

      console.log(
        `[openrouter] ${model} | ${usage?.prompt_tokens ?? 0}in/${usage?.completion_tokens ?? 0}out | ${elapsed}ms`
      );

      reportProviderSuccess("openrouter");
      return text;
    } catch (err) {
      lastError = err as Error;
      // Only retry on network errors or rate limits, not on 4xx auth errors
      if ((err as any)?.message?.includes("429") || (err as any)?.message?.includes("502") || (err as any)?.message?.includes("503")) {
        continue;
      }
      throw err; // non-retryable error
    }
  }

  // All retries exhausted — report to circuit breaker
  const errMsg = lastError?.message ?? "all retries exhausted";
  reportProviderFailure("openrouter", errMsg).catch(() => {});
  throw lastError ?? new Error("OpenRouter: all retries exhausted");
}
