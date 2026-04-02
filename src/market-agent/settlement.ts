import type { Database } from 'sql.js';
import { withDb } from '../storage/sqlite.js';
import { KalshiRest } from './kalshi-rest.js';
import { PerformanceTracker } from './performance.js';
import { SafetyGuard } from './safety.js';
import { notify } from './notifications.js';
import { CITIES } from './types.js';

/**
 * Settlement service — resolves open trades against Kalshi market outcomes.
 * 
 * Runs on a timer (default: every 4 hours starting at 10am ET).
 * Queries Kalshi for settled KXHIGH markets, cross-references with
 * unsettled trades in trade_performance, and records outcomes.
 */

interface SettlementResult {
  ticker: string;
  outcome: 'win' | 'loss';
  marketResult: string;  // 'yes' | 'no'
  tradeSide: string;
  pnl: number;
  contracts: number;
  fillPrice: number;
}
export class SettlementService {
  private rest: KalshiRest;
  private performance: PerformanceTracker;
  private safety: SafetyGuard;
  private timer: NodeJS.Timeout | null = null;
  private lastRunDate: string = '';

  constructor(rest: KalshiRest, performance: PerformanceTracker, safety: SafetyGuard) {
    this.rest = rest;
    this.performance = performance;
    this.safety = safety;
  }

  /**
   * Start the settlement check timer.
   * Checks every 4 hours — Kalshi settles KXHIGH markets by ~9am ET next day.
   */
  start(): void {
    // Run immediately on start, then every 4 hours
    this.checkSettlements().catch(err => {
      console.error('[settlement] Initial check failed:', err);
    });
    this.timer = setInterval(() => {
      this.checkSettlements().catch(err => {
        console.error('[settlement] Periodic check failed:', err);
      });
    }, 4 * 60 * 60 * 1000); // 4 hours
    console.log('[settlement] Service started (checking every 4h)');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
  /**
   * Core settlement loop:
   * 1. Load unsettled trades from DB
   * 2. Query Kalshi for market status on those tickers
   * 3. For settled markets, determine win/loss and record
   */
  async checkSettlements(): Promise<SettlementResult[]> {
    const results: SettlementResult[] = [];

    // 1. Get all unsettled trade tickers from DB
    const unsettledTrades = await this.getUnsettledTrades();
    if (unsettledTrades.length === 0) {
      console.log('[settlement] No unsettled trades to check');
      return results;
    }

    console.log(`[settlement] Checking ${unsettledTrades.length} unsettled trades`);

    // 2. Query Kalshi for each unique ticker's market status
    const checkedTickers = new Set<string>();
    for (const trade of unsettledTrades) {
      if (checkedTickers.has(trade.ticker)) continue;
      checkedTickers.add(trade.ticker);

      try {
        const market = await this.rest.getMarket(trade.ticker);
        if (!market) continue;

        // Only process settled/closed markets
        if (market.status !== 'settled' && market.status !== 'closed') continue;

        const marketResult = market.result; // 'yes' or 'no'
        if (!marketResult) {
          console.warn(`[settlement] Market ${trade.ticker} is ${market.status} but has no result`);
          continue;
        }

        // Find all trades for this ticker
        const tickerTrades = unsettledTrades.filter(t => t.ticker === trade.ticker);
        for (const t of tickerTrades) {
          const outcome = this.determineOutcome(t.side, marketResult);
          const pnl = this.calculatePnl(outcome, t.contracts, t.fillPrice);

          // Record settlement
          await this.performance.recordSettlement(t.ticker, outcome, 0, pnl);
          this.safety.recordSettlement(t.ticker, pnl);

          // Log to events table
          await withDb(async (db: Database) => {
            db.run(
              `INSERT INTO events (event_type, timestamp_ms, market_ticker, payload) VALUES (?, ?, ?, ?)`,
              [
                'settlement',
                Date.now(),
                t.ticker,
                JSON.stringify({
                  ticker: t.ticker,
                  result: marketResult,
                  side: t.side,
                  outcome,
                  contracts: t.contracts,
                  fillPrice: t.fillPrice,
                  pnl,
                  paperTrade: t.paperTrade,
                }),
              ]
            );
          }, { db: 'market-agent', persist: true });

          results.push({
            ticker: t.ticker,
            outcome,
            marketResult,
            tradeSide: t.side,
            pnl,
            contracts: t.contracts,
            fillPrice: t.fillPrice,
          });

          console.log(
            `[settlement] ${outcome.toUpperCase()}: ${t.ticker} | ` +
            `side=${t.side} result=${marketResult} | ` +
            `${t.contracts}@$${t.fillPrice.toFixed(2)} → P&L $${pnl.toFixed(2)}`
          );
        }
      } catch (err) {
        console.error(`[settlement] Failed to check ${trade.ticker}:`, (err as Error).message);
      }
    }

    if (results.length > 0) {
      const wins = results.filter(r => r.outcome === 'win').length;
      const totalPnl = results.reduce((sum, r) => sum + r.pnl, 0);
      const msg = `Settlement: ${results.length} trades resolved | ${wins}W/${results.length - wins}L | P&L $${totalPnl.toFixed(2)}`;
      console.log(`[settlement] ${msg}`);
      await notify(msg);
    }

    return results;
  }
  /**
   * Determine win/loss based on trade side and market result.
   * - YES-BUY wins if market resolves YES
   * - NO-BUY wins if market resolves NO
   */
  private determineOutcome(tradeSide: string, marketResult: string): 'win' | 'loss' {
    if (tradeSide === 'yes' && marketResult === 'yes') return 'win';
    if (tradeSide === 'no' && marketResult === 'no') return 'win';
    return 'loss';
  }

  /**
   * Calculate P&L for a settled trade.
   * Win: payout ($1/contract) minus cost
   * Loss: negative cost (total loss of investment)
   */
  private calculatePnl(outcome: 'win' | 'loss', contracts: number, fillPrice: number): number {
    const cost = contracts * fillPrice;
    if (outcome === 'win') {
      return (contracts * 1.0) - cost; // $1 payout per contract minus cost
    }
    return -cost; // total loss
  }

  /**
   * Load unsettled trades from DB.
   */
  private async getUnsettledTrades(): Promise<Array<{
    ticker: string;
    side: string;
    contracts: number;
    fillPrice: number;
    paperTrade: boolean;
  }>> {
    return await withDb(async (db: Database) => {
      const stmt = db.prepare(
        `SELECT ticker, side, contracts, fill_price, paper_trade
         FROM trade_performance 
         WHERE outcome IS NULL
         ORDER BY created_at ASC`
      );
      const trades: Array<{ ticker: string; side: string; contracts: number; fillPrice: number; paperTrade: boolean }> = [];
      while (stmt.step()) {
        const row = stmt.getAsObject() as any;
        trades.push({
          ticker: row.ticker,
          side: row.side || (row.fill_price < 0.50 ? 'yes' : 'no'), // fallback for pre-migration rows
          contracts: row.contracts,
          fillPrice: row.fill_price,
          paperTrade: !!row.paper_trade,
        });
      }
      stmt.free();
      return trades;
    }, { db: 'market-agent' });
  }

  /** Manual trigger for testing */
  async runNow(): Promise<SettlementResult[]> {
    return this.checkSettlements();
  }
}