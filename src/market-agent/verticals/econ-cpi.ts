/**
 * Economics Vertical — CPI / Inflation / Fed Rate markets
 *
 * Data sources:
 *   - Cleveland Fed Inflation Nowcasting (daily PCE/CPI nowcast)
 *   - Philadelphia Fed Survey of Professional Forecasters (quarterly)
 *   - Atlanta Fed GDPNow (real-time GDP tracking)
 *
 * Kalshi markets:
 *   - KXCPI* — CPI YoY range buckets
 *   - KXFED* — Fed funds rate decision (25bp, 50bp, hold)
 *   - KXINFL* — Inflation threshold markets
 *
 * Strategy: Nowcast divergence from market pricing.
 * The Cleveland Fed updates daily with a statistical model that combines
 * treasury yields, oil prices, and CPI components. When nowcast diverges
 * from Kalshi implied probability by > edge threshold, trade.
 */

import { MispricingSignal } from '../types.js';
import { IVerticalStrategy, DataSourceConfig, VerticalStatus } from './strategy.js';
import { calculatePositionSize } from '../kelly.js';

interface NowcastData {
  date: string;
  cpiYoY: number;          // CPI year-over-year % nowcast
  pceYoY: number;          // PCE year-over-year % nowcast
  coreInflation: number;   // Core CPI (ex food/energy)
  confidence: number;      // model confidence 0-1
  source: string;
  fetchedAt: number;
}

interface CpiBucket {
  lower: number;   // e.g., 2.5
  upper: number;   // e.g., 3.0
  ticker: string;
}

const CLEVELAND_FED_URL = 'https://www.clevelandfed.org/api/inflation-nowcasting/latest';
const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours — nowcast updates ~daily

export class EconCpiStrategy implements IVerticalStrategy {
  readonly name = 'econ-cpi';
  readonly description = 'CPI/Inflation nowcast vs Kalshi CPI range markets';
  readonly seriesPrefixes = ['KXCPI', 'KXINFL', 'KXFED'];

  private latestNowcast: NowcastData | null = null;
  private lastPollMs = 0;
  private lastError: string | undefined;

  getDataSources(): DataSourceConfig[] {
    return [{
      name: 'Cleveland Fed Inflation Nowcast',
      url: CLEVELAND_FED_URL,
      pollIntervalMs: POLL_INTERVAL_MS,
    }];
  }

  async initialize(): Promise<void> {
    await this.pollData();
  }

  async pollData(): Promise<void> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(CLEVELAND_FED_URL, { signal: controller.signal });
      clearTimeout(timeout);

      if (!res.ok) {
        // Cleveland Fed may not have a public JSON API — fallback to scraping
        // For now, log and continue; real implementation will parse their data page
        this.lastError = `Cleveland Fed API returned ${res.status}`;
        console.warn(`[econ-cpi] ${this.lastError}`);
        return;
      }

      const data = await res.json() as any;
      this.latestNowcast = {
        date: data.date || new Date().toISOString().slice(0, 10),
        cpiYoY: Number(data.cpi_yoy ?? data.inflation ?? 0),
        pceYoY: Number(data.pce_yoy ?? 0),
        coreInflation: Number(data.core_cpi ?? 0),
        confidence: 0.85,  // Cleveland Fed model has ~85% CI
        source: 'cleveland-fed',
        fetchedAt: Date.now(),
      };
      this.lastPollMs = Date.now();
      this.lastError = undefined;
      console.log(`[econ-cpi] Nowcast updated: CPI ${this.latestNowcast.cpiYoY}%`);
    } catch (err) {
      this.lastError = (err as Error).message;
      console.error(`[econ-cpi] Poll failed: ${this.lastError}`);
    }
  }

  generateSignals(
    marketMeta: Map<string, { title: string; ticker: string }>,
    tickerPrices: Map<string, { yes_bid: number; yes_ask: number }>,
    bankroll: number,
    kellyFraction: number,
    edgeThreshold: number,
  ): MispricingSignal[] {
    if (!this.latestNowcast) return [];

    const signals: MispricingSignal[] = [];

    for (const [ticker, meta] of marketMeta) {
      // Only process CPI/inflation markets
      if (!this.seriesPrefixes.some(p => ticker.startsWith(p))) continue;

      const prices = tickerPrices.get(ticker);
      if (!prices || prices.yes_ask <= 0) continue;

      // Parse CPI bucket from title (e.g., "CPI YoY 2.5% - 3.0%")
      const bucket = this.parseCpiBucket(meta.title);
      if (!bucket) continue;

      // Probability the CPI lands in this bucket using normal distribution
      const stdDev = 0.3;  // CPI nowcast typically ±0.3% accurate
      const prob = this.bucketProbability(this.latestNowcast.cpiYoY, bucket.lower, bucket.upper, stdDev);

      if (prob < 0.05) continue;

      const bestAsk = prices.yes_ask;
      const expectedValue = prob * 1.0;
      const edge = expectedValue - bestAsk;

      if (edge < edgeThreshold) continue;

      const sizing = calculatePositionSize(prob, bestAsk, bankroll, kellyFraction, 0.25);

      signals.push({
        ticker, city: 'ECON', targetDate: this.latestNowcast.date,
        noaaForecastF: this.latestNowcast.cpiYoY, // repurpose field for nowcast value
        noaaConfidence: prob, bucketRange: [bucket.lower, bucket.upper],
        marketPrice: bestAsk, impliedProb: bestAsk,
        expectedValue, edge, kellyFraction: sizing.kellyAdjusted,
        recommendedContracts: sizing.contracts, side: 'yes', action: 'buy',
      });
    }

    return signals;
  }

  private parseCpiBucket(title: string): { lower: number; upper: number } | null {
    const clean = title.replace(/\*\*/g, '');
    // Match "2.5% - 3.0%" or "2.5 - 3.0"
    const rangeMatch = clean.match(/(\d+(?:\.\d+)?)\s*%?\s*[-–]\s*(\d+(?:\.\d+)?)\s*%?/);
    if (rangeMatch) return { lower: parseFloat(rangeMatch[1]), upper: parseFloat(rangeMatch[2]) };
    // Match ">3.0%" or "above 3.0%"
    const gtMatch = clean.match(/>(\d+(?:\.\d+)?)\s*%|above\s+(\d+(?:\.\d+)?)/i);
    if (gtMatch) return { lower: parseFloat(gtMatch[1] || gtMatch[2]), upper: 20 };
    // Match "<2.0%" or "below 2.0%"
    const ltMatch = clean.match(/<(\d+(?:\.\d+)?)\s*%|below\s+(\d+(?:\.\d+)?)/i);
    if (ltMatch) return { lower: -5, upper: parseFloat(ltMatch[1] || ltMatch[2]) };
    return null;
  }

  private bucketProbability(forecast: number, lower: number, upper: number, stdDev: number): number {
    const phi = (x: number): number => {
      const t = 1 / (1 + 0.2316419 * Math.abs(x));
      const d = 0.3989422804014327;
      const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
      const cdf = 1.0 - d * Math.exp(-0.5 * x * x) * poly;
      return x >= 0 ? cdf : 1 - cdf;
    };
    const adjLower = lower <= -5 ? -50 : lower;
    const adjUpper = upper >= 20 ? 50 : upper;
    return Math.max(0, Math.min(1, phi((adjUpper - forecast) / stdDev) - phi((adjLower - forecast) / stdDev)));
  }

  getConfidence(hoursAhead: number): number {
    // CPI nowcast is most accurate close to release date
    if (hoursAhead <= 48) return 0.90;
    if (hoursAhead <= 168) return 0.85; // within a week
    return 0.75;
  }

  getStatus(): VerticalStatus {
    return {
      name: this.name,
      enabled: true,
      lastPollMs: this.lastPollMs,
      signalCount: 0,
      error: this.lastError,
    };
  }

  shutdown(): void {
    this.latestNowcast = null;
    console.log('[econ-cpi] Shutdown');
  }
}
