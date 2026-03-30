/**
 * IVerticalStrategy — common interface for all market verticals.
 * Each strategy plugs into the MarketAgent orchestrator and produces
 * MispricingSignal[] that flow through the shared execution pipeline.
 */

import { MispricingSignal } from '../types.js';

export interface DataSourceConfig {
  name: string;
  url: string;
  pollIntervalMs: number;
  /** Optional API key env var name */
  apiKeyEnv?: string;
}

export interface VerticalStatus {
  name: string;
  enabled: boolean;
  lastPollMs: number;
  signalCount: number;
  error?: string;
}

export interface IVerticalStrategy {
  /** Unique identifier (e.g., 'weather', 'econ-cpi', 'crypto-btc') */
  readonly name: string;

  /** Human-readable description */
  readonly description: string;

  /** Kalshi series ticker prefixes this strategy trades */
  readonly seriesPrefixes: string[];

  /** External data sources required */
  getDataSources(): DataSourceConfig[];

  /** Initialize data feeds, authenticate if needed */
  initialize(): Promise<void>;

  /** Poll external data — called on interval by orchestrator */
  pollData(): Promise<void>;

  /**
   * Generate trading signals from current data vs Kalshi market prices.
   * @param marketMeta - available Kalshi markets (ticker → title)
   * @param tickerPrices - live bid/ask from WS ticker channel
   * @param bankroll - current account balance
   * @param kellyFraction - position sizing multiplier
   * @param edgeThreshold - minimum edge to generate signal
   */
  generateSignals(
    marketMeta: Map<string, { title: string; ticker: string }>,
    tickerPrices: Map<string, { yes_bid: number; yes_ask: number }>,
    bankroll: number,
    kellyFraction: number,
    edgeThreshold: number,
  ): MispricingSignal[];

  /** Model confidence at given hours-ahead (0-1) */
  getConfidence(hoursAhead: number): number;

  /** Current status for dashboard */
  getStatus(): VerticalStatus;

  /** Graceful shutdown */
  shutdown(): void;
}

/**
 * Registry of all available verticals.
 * Orchestrator iterates this to poll data and generate signals.
 */
export class VerticalRegistry {
  private strategies: Map<string, IVerticalStrategy> = new Map();

  register(strategy: IVerticalStrategy): void {
    this.strategies.set(strategy.name, strategy);
    console.log(`[verticals] Registered: ${strategy.name} — ${strategy.description}`);
  }

  unregister(name: string): void {
    const s = this.strategies.get(name);
    if (s) {
      s.shutdown();
      this.strategies.delete(name);
    }
  }

  getAll(): IVerticalStrategy[] {
    return Array.from(this.strategies.values());
  }

  get(name: string): IVerticalStrategy | undefined {
    return this.strategies.get(name);
  }

  async pollAll(): Promise<void> {
    const results = await Promise.allSettled(
      this.getAll().map(s => s.pollData())
    );
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'rejected') {
        console.error(`[verticals] Poll failed for ${this.getAll()[i].name}:`, (results[i] as PromiseRejectedResult).reason);
      }
    }
  }

  generateAllSignals(
    marketMeta: Map<string, { title: string; ticker: string }>,
    tickerPrices: Map<string, { yes_bid: number; yes_ask: number }>,
    bankroll: number,
    kellyFraction: number,
    edgeThreshold: number,
  ): MispricingSignal[] {
    const signals: MispricingSignal[] = [];
    for (const strategy of this.getAll()) {
      try {
        const s = strategy.generateSignals(marketMeta, tickerPrices, bankroll, kellyFraction, edgeThreshold);
        signals.push(...s);
      } catch (err) {
        console.error(`[verticals] Signal generation failed for ${strategy.name}:`, err);
      }
    }
    return signals;
  }

  getStatuses(): VerticalStatus[] {
    return this.getAll().map(s => s.getStatus());
  }
}
