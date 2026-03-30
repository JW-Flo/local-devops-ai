/**
 * Crypto Vertical — BTC/ETH price range markets
 *
 * Data sources:
 *   - Coinbase/Binance public ticker API (free, real-time)
 *   - On-chain: mempool.space for BTC fee rates / congestion signal
 *   - Funding rates from exchange derivatives (sentiment proxy)
 *
 * Kalshi markets:
 *   - KXBTC* — Bitcoin price range buckets (e.g., "BTC above $90K on Apr 5")
 *   - KXETH* — Ethereum price range buckets
 *
 * Strategy: Momentum + mean-reversion hybrid.
 * Use 24h VWAP + Bollinger bands to estimate probability of price ranges,
 * then compare to Kalshi market prices for edge detection.
 */

import { MispricingSignal } from '../types.js';
import { IVerticalStrategy, DataSourceConfig, VerticalStatus } from './strategy.js';
import { calculatePositionSize } from '../kelly.js';

interface PriceSnapshot {
  symbol: string;
  price: number;
  vwap24h: number;
  volume24h: number;
  high24h: number;
  low24h: number;
  timestamp: number;
}

interface HistoricalCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: number;
}

const COINBASE_TICKER_URL = 'https://api.coinbase.com/v2/prices';
const COINBASE_CANDLES_URL = 'https://api.exchange.coinbase.com/products';
const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 min — crypto moves fast
const LOOKBACK_CANDLES = 24; // 24 hourly candles for volatility estimation

export class CryptoBtcStrategy implements IVerticalStrategy {
  readonly name = 'crypto-btc';
  readonly description = 'BTC/ETH price range prediction vs Kalshi crypto markets';
  readonly seriesPrefixes = ['KXBTC', 'KXETH', 'KXBITCOIN'];

  private latestPrice: PriceSnapshot | null = null;
  private candles: HistoricalCandle[] = [];
  private volatility24h = 0;   // annualized vol from hourly candles
  private lastPollMs = 0;
  private lastError: string | undefined;

  getDataSources(): DataSourceConfig[] {
    return [
      { name: 'Coinbase Ticker', url: COINBASE_TICKER_URL, pollIntervalMs: POLL_INTERVAL_MS },
      { name: 'Coinbase Candles', url: COINBASE_CANDLES_URL, pollIntervalMs: POLL_INTERVAL_MS },
    ];
  }

  async initialize(): Promise<void> {
    await this.pollData();
  }

  async pollData(): Promise<void> {
    try {
      // Fetch current BTC price
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const priceRes = await fetch(`${COINBASE_TICKER_URL}/BTC-USD/spot`, { signal: controller.signal });
      clearTimeout(timeout);

      if (!priceRes.ok) {
        this.lastError = `Coinbase price API: ${priceRes.status}`;
        console.warn(`[crypto-btc] ${this.lastError}`);
        return;
      }
      const priceData = await priceRes.json() as any;
      const currentPrice = Number(priceData.data?.amount ?? 0);
      if (currentPrice <= 0) return;

      // Fetch hourly candles for volatility estimation
      const candleController = new AbortController();
      const candleTimeout = setTimeout(() => candleController.abort(), 10000);
      const candleRes = await fetch(
        `${COINBASE_CANDLES_URL}/BTC-USD/candles?granularity=3600`,
        { signal: candleController.signal }
      );
      clearTimeout(candleTimeout);

      if (candleRes.ok) {
        const rawCandles = await candleRes.json() as number[][];
        this.candles = rawCandles.slice(0, LOOKBACK_CANDLES).map(c => ({
          timestamp: c[0], low: c[1], high: c[2], open: c[3], close: c[4], volume: c[5],
        }));
        // Compute realized volatility from hourly log returns
        if (this.candles.length >= 2) {
          const logReturns = [];
          for (let i = 1; i < this.candles.length; i++) {
            logReturns.push(Math.log(this.candles[i-1].close / this.candles[i].close));
          }
          const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
          const variance = logReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / logReturns.length;
          this.volatility24h = Math.sqrt(variance) * Math.sqrt(24 * 365); // annualized
        }
      }

      this.latestPrice = {
        symbol: 'BTC-USD',
        price: currentPrice,
        vwap24h: currentPrice, // simplified — could compute from candles
        volume24h: this.candles.reduce((s, c) => s + c.volume, 0),
        high24h: Math.max(...this.candles.map(c => c.high), currentPrice),
        low24h: Math.min(...this.candles.map(c => c.low), currentPrice),
        timestamp: Date.now(),
      };

      this.lastPollMs = Date.now();
      this.lastError = undefined;
      console.log(`[crypto-btc] BTC $${currentPrice.toLocaleString()} | vol ${(this.volatility24h * 100).toFixed(1)}%`);
    } catch (err) {
      this.lastError = (err as Error).message;
      console.error(`[crypto-btc] Poll failed: ${this.lastError}`);
    }
  }

  generateSignals(
    marketMeta: Map<string, { title: string; ticker: string }>,
    tickerPrices: Map<string, { yes_bid: number; yes_ask: number }>,
    bankroll: number,
    kellyFraction: number,
    edgeThreshold: number,
  ): MispricingSignal[] {
    if (!this.latestPrice || this.volatility24h <= 0) return [];

    const signals: MispricingSignal[] = [];

    for (const [ticker, meta] of marketMeta) {
      if (!this.seriesPrefixes.some(p => ticker.startsWith(p))) continue;

      const prices = tickerPrices.get(ticker);
      if (!prices || prices.yes_ask <= 0) continue;

      // Parse price bucket from title (e.g., "BTC above $90,000" or "BTC $85K-$90K")
      const bucket = this.parsePriceBucket(meta.title);
      if (!bucket) continue;

      // Estimate hours until market settles (parse date from ticker)
      const hoursAhead = this.estimateHoursAhead(ticker);
      if (hoursAhead <= 0) continue;

      // Use log-normal model: price follows GBM with measured volatility
      const hourlyVol = this.volatility24h / Math.sqrt(24 * 365);
      const totalVol = hourlyVol * Math.sqrt(hoursAhead);
      const prob = this.priceBucketProbability(this.latestPrice.price, bucket.lower, bucket.upper, totalVol);

      if (prob < 0.05) continue;

      const bestAsk = prices.yes_ask;
      const expectedValue = prob * 1.0;
      const edge = expectedValue - bestAsk;

      if (edge < edgeThreshold) continue;

      const sizing = calculatePositionSize(prob, bestAsk, bankroll, kellyFraction, 0.25);

      signals.push({
        ticker, city: 'BTC', targetDate: '', noaaForecastF: this.latestPrice.price,
        noaaConfidence: prob, bucketRange: [bucket.lower, bucket.upper],
        marketPrice: bestAsk, impliedProb: bestAsk, expectedValue, edge,
        kellyFraction: sizing.kellyAdjusted, recommendedContracts: sizing.contracts,
        side: 'yes', action: 'buy',
      });
    }

    return signals;
  }

  private parsePriceBucket(title: string): { lower: number; upper: number } | null {
    const clean = title.replace(/\*\*/g, '').replace(/,/g, '');
    // "above $90000" or ">$90K"
    const gtMatch = clean.match(/(?:above|>)\s*\$?(\d+(?:\.\d+)?)\s*[Kk]?/i);
    if (gtMatch) {
      let val = parseFloat(gtMatch[1]);
      if (clean.toLowerCase().includes('k')) val *= 1000;
      return { lower: val, upper: 1_000_000 };
    }
    // "below $80000" or "<$80K"
    const ltMatch = clean.match(/(?:below|<)\s*\$?(\d+(?:\.\d+)?)\s*[Kk]?/i);
    if (ltMatch) {
      let val = parseFloat(ltMatch[1]);
      if (clean.toLowerCase().includes('k')) val *= 1000;
      return { lower: 0, upper: val };
    }
    // Range: "$85000-$90000" or "$85K-$90K"
    const rangeMatch = clean.match(/\$?(\d+(?:\.\d+)?)\s*[Kk]?\s*[-–]\s*\$?(\d+(?:\.\d+)?)\s*[Kk]?/);
    if (rangeMatch) {
      let lower = parseFloat(rangeMatch[1]);
      let upper = parseFloat(rangeMatch[2]);
      if (lower < 1000 && upper < 1000) { lower *= 1000; upper *= 1000; }
      return { lower, upper };
    }
    return null;
  }

  private estimateHoursAhead(ticker: string): number {
    // Try to parse date from ticker like KXBTC-26APR05
    const m = ticker.match(/-(\d{2})([A-Z]{3})(\d{2})/);
    if (!m) return 24; // default 24h
    const monthMap: Record<string, string> = {
      JAN:'01',FEB:'02',MAR:'03',APR:'04',MAY:'05',JUN:'06',
      JUL:'07',AUG:'08',SEP:'09',OCT:'10',NOV:'11',DEC:'12',
    };
    const month = monthMap[m[2]];
    if (!month) return 24;
    const target = new Date(`20${m[1]}-${month}-${m[3]}T23:59:59Z`);
    return Math.max(1, (target.getTime() - Date.now()) / 3600000);
  }

  /**
   * Log-normal probability that price lands in [lower, upper] given current
   * price and total volatility over the period.
   */
  private priceBucketProbability(currentPrice: number, lower: number, upper: number, totalVol: number): number {
    if (totalVol <= 0) return 0;
    const phi = (x: number): number => {
      const t = 1 / (1 + 0.2316419 * Math.abs(x));
      const d = 0.3989422804014327;
      const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
      const cdf = 1.0 - d * Math.exp(-0.5 * x * x) * poly;
      return x >= 0 ? cdf : 1 - cdf;
    };
    // Log-normal: ln(S_T/S_0) ~ N(-σ²/2, σ²)
    const drift = -0.5 * totalVol * totalVol;
    const zLower = lower <= 0 ? -10 : (Math.log(lower / currentPrice) - drift) / totalVol;
    const zUpper = upper >= 1_000_000 ? 10 : (Math.log(upper / currentPrice) - drift) / totalVol;
    return Math.max(0, Math.min(1, phi(zUpper) - phi(zLower)));
  }

  getConfidence(hoursAhead: number): number {
    // Crypto is volatile — confidence drops fast
    if (hoursAhead <= 6) return 0.75;
    if (hoursAhead <= 24) return 0.60;
    if (hoursAhead <= 72) return 0.45;
    return 0.30;
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
    this.latestPrice = null;
    this.candles = [];
    console.log('[crypto-btc] Shutdown');
  }
}
