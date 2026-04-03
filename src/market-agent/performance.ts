import type { Database } from 'sql.js';
import { withDb } from '../storage/sqlite.js';
import { MispricingSignal } from './types.js';

/**
 * Performance tracker — records predictions vs outcomes, computes accuracy,
 * and recommends parameter adjustments based on historical data.
 *
 * Tracks:
 * - Signal accuracy: did our probability estimate predict the correct outcome?
 * - Edge realization: did the edge we calculated materialize as profit?
 * - Haiku validation quality: did Haiku approvals correlate with winning trades?
 * - City-level bias: are we systematically wrong about certain cities?
 */

export interface TradeRecord {
  ticker: string;
  city: string;
  targetDate: string;
  side: 'yes' | 'no';
  predictedProb: number;
  marketPrice: number;
  edge: number;
  kellyFraction: number;
  contracts: number;
  fillPrice: number;
  haikuApproved: boolean;
  haikuConfidence: number;
  paperTrade: boolean;
  timestamp: number;
  // Filled after settlement
  outcome?: 'win' | 'loss';
  actualHighF?: number;
  pnl?: number;
}

export interface PerformanceStats {
  totalTrades: number;
  settled: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnL: number;
  avgEdge: number;
  avgRealizedEdge: number;
  cityBreakdown: Record<string, { trades: number; wins: number; pnl: number }>;
  recommendedAdjustments: ParameterAdjustment[];
}

export interface ParameterAdjustment {
  parameter: string;
  currentValue: number;
  recommendedValue: number;
  reason: string;
  confidence: 'low' | 'medium' | 'high';
}

const MIN_TRADES_FOR_TUNING = 20; // need enough data before recommending changes
const MIN_CITY_TRADES = 5;        // per-city minimum before flagging bias

export class PerformanceTracker {
  private trades: TradeRecord[] = [];
  private initialized = false;

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await withDb(async (db: Database) => {
      db.run(`CREATE TABLE IF NOT EXISTS trade_performance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticker TEXT NOT NULL,
        city TEXT NOT NULL,
        target_date TEXT NOT NULL,
        side TEXT NOT NULL DEFAULT 'yes',
        predicted_prob REAL NOT NULL,
        market_price REAL NOT NULL,
        edge REAL NOT NULL,
        kelly_fraction REAL NOT NULL,
        contracts INTEGER NOT NULL,
        fill_price REAL NOT NULL,
        haiku_approved INTEGER NOT NULL,
        haiku_confidence INTEGER NOT NULL,
        paper_trade INTEGER NOT NULL DEFAULT 0,
        outcome TEXT,
        actual_high_f REAL,
        pnl REAL,
        created_at INTEGER NOT NULL,
        settled_at INTEGER
      )`);
      // Migration: add side column to existing tables that lack it
      try {
        db.run(`ALTER TABLE trade_performance ADD COLUMN side TEXT NOT NULL DEFAULT 'yes'`);
      } catch (_) { /* column already exists */ }
    }, { db: 'market-agent', persist: true });

    // Load existing records
    await withDb(async (db: Database) => {
      const stmt = db.prepare('SELECT * FROM trade_performance ORDER BY created_at DESC LIMIT 500');
      while (stmt.step()) {
        const row = stmt.getAsObject() as any;
        this.trades.push({
          ticker: row.ticker,
          city: row.city,
          targetDate: row.target_date,
          side: row.side || 'yes',
          predictedProb: row.predicted_prob,
          marketPrice: row.market_price,
          edge: row.edge,
          kellyFraction: row.kelly_fraction,
          contracts: row.contracts,
          fillPrice: row.fill_price,
          haikuApproved: !!row.haiku_approved,
          haikuConfidence: row.haiku_confidence,
          paperTrade: !!row.paper_trade,
          outcome: row.outcome || undefined,
          actualHighF: row.actual_high_f || undefined,
          pnl: row.pnl || undefined,
          timestamp: row.created_at,
        });
      }
      stmt.free();
    }, { db: 'market-agent' });

    this.initialized = true;
    console.log(`[performance] Loaded ${this.trades.length} historical trades`);
  }

  async recordTrade(signal: MispricingSignal, fillPrice: number, haikuApproved: boolean, haikuConfidence: number, paperTrade: boolean): Promise<void> {
    const record: TradeRecord = {
      ticker: signal.ticker,
      city: signal.city,
      targetDate: signal.targetDate,
      side: signal.side || 'yes',
      predictedProb: signal.noaaConfidence,
      marketPrice: signal.marketPrice,
      edge: signal.edge,
      kellyFraction: signal.kellyFraction,
      contracts: signal.recommendedContracts,
      fillPrice,
      haikuApproved,
      haikuConfidence,
      paperTrade,
      timestamp: Date.now(),
    };

    this.trades.push(record);

    await withDb(async (db: Database) => {
      db.run(
        `INSERT INTO trade_performance (ticker, city, target_date, side, predicted_prob, market_price, edge, kelly_fraction, contracts, fill_price, haiku_approved, haiku_confidence, paper_trade, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [record.ticker, record.city, record.targetDate, record.side, record.predictedProb, record.marketPrice, record.edge, record.kellyFraction, record.contracts, record.fillPrice, record.haikuApproved ? 1 : 0, record.haikuConfidence, record.paperTrade ? 1 : 0, record.timestamp]
      );
    }, { db: 'market-agent', persist: true });
  }

  async recordSettlement(ticker: string, outcome: 'win' | 'loss', actualHighF: number | null, pnl: number): Promise<void> {
    const trade = this.trades.find(t => t.ticker === ticker && !t.outcome);
    if (trade) {
      trade.outcome = outcome;
      trade.actualHighF = actualHighF || undefined;
      trade.pnl = pnl;
    }

    await withDb(async (db: Database) => {
      db.run(
        `UPDATE trade_performance SET outcome = ?, actual_high_f = ?, pnl = ?, settled_at = ? WHERE ticker = ? AND outcome IS NULL`,
        [outcome, actualHighF, pnl, Date.now(), ticker]
      );
    }, { db: 'market-agent', persist: true });

    console.log(`[performance] Settlement: ${ticker} ${outcome} | actual=${actualHighF}°F pnl=$${pnl.toFixed(2)}`);
  }

  getStats(): PerformanceStats {
    const settled = this.trades.filter(t => t.outcome);
    const wins = settled.filter(t => t.outcome === 'win');
    const totalPnL = settled.reduce((sum, t) => sum + (t.pnl || 0), 0);
    const avgEdge = this.trades.length > 0
      ? this.trades.reduce((sum, t) => sum + t.edge, 0) / this.trades.length
      : 0;
    const avgRealizedEdge = settled.length > 0
      ? settled.reduce((sum, t) => sum + (t.pnl || 0) / Math.max(1, t.contracts), 0) / settled.length
      : 0;

    // City breakdown
    const cityBreakdown: Record<string, { trades: number; wins: number; pnl: number }> = {};
    for (const t of this.trades) {
      if (!cityBreakdown[t.city]) cityBreakdown[t.city] = { trades: 0, wins: 0, pnl: 0 };
      cityBreakdown[t.city].trades++;
      if (t.outcome === 'win') cityBreakdown[t.city].wins++;
      cityBreakdown[t.city].pnl += t.pnl || 0;
    }

    return {
      totalTrades: this.trades.length,
      settled: settled.length,
      wins: wins.length,
      losses: settled.length - wins.length,
      winRate: settled.length > 0 ? wins.length / settled.length : 0,
      totalPnL,
      avgEdge,
      avgRealizedEdge,
      cityBreakdown,
      recommendedAdjustments: this.computeAdjustments(),
    };
  }

  /**
   * Self-tuning: analyze historical accuracy and recommend parameter adjustments.
   * Conservative — only suggests changes with enough data and clear signal.
   */
  private computeAdjustments(): ParameterAdjustment[] {
    const adjustments: ParameterAdjustment[] = [];
    const settled = this.trades.filter(t => t.outcome);

    if (settled.length < MIN_TRADES_FOR_TUNING) {
      adjustments.push({
        parameter: 'none',
        currentValue: 0,
        recommendedValue: 0,
        reason: `Need ${MIN_TRADES_FOR_TUNING - settled.length} more settled trades before tuning`,
        confidence: 'low',
      });
      return adjustments;
    }

    const winRate = settled.filter(t => t.outcome === 'win').length / settled.length;

    // 1. Edge threshold tuning
    // If win rate < 45%, our edge estimates are too optimistic — raise threshold
    // If win rate > 70%, we're leaving money on the table — can lower threshold
    if (winRate < 0.45) {
      const avgLosingEdge = settled
        .filter(t => t.outcome === 'loss')
        .reduce((sum, t) => sum + t.edge, 0) / Math.max(1, settled.filter(t => t.outcome === 'loss').length);
      adjustments.push({
        parameter: 'EDGE_THRESHOLD',
        currentValue: 0.03,
        recommendedValue: Math.max(0.05, avgLosingEdge * 1.5),
        reason: `Win rate ${(winRate * 100).toFixed(0)}% < 45% — losing trades avg edge $${avgLosingEdge.toFixed(3)}, raise threshold to filter weak signals`,
        confidence: settled.length >= 50 ? 'high' : 'medium',
      });
    } else if (winRate > 0.70) {
      adjustments.push({
        parameter: 'EDGE_THRESHOLD',
        currentValue: 0.03,
        recommendedValue: 0.02,
        reason: `Win rate ${(winRate * 100).toFixed(0)}% > 70% — can capture more marginal opportunities`,
        confidence: settled.length >= 50 ? 'high' : 'medium',
      });
    }

    // 2. Kelly fraction tuning — based on variance of outcomes
    const pnls = settled.map(t => t.pnl || 0);
    const avgPnl = pnls.reduce((a, b) => a + b, 0) / pnls.length;
    const variance = pnls.reduce((sum, p) => sum + Math.pow(p - avgPnl, 2), 0) / pnls.length;
    const stdDev = Math.sqrt(variance);

    // High variance → reduce Kelly fraction for smoother equity curve
    if (stdDev > avgPnl * 3 && avgPnl > 0) {
      adjustments.push({
        parameter: 'KELLY_FRACTION',
        currentValue: 0.25,
        recommendedValue: 0.15,
        reason: `High P&L variance (σ=$${stdDev.toFixed(2)}) relative to mean ($${avgPnl.toFixed(2)}) — reduce position sizing`,
        confidence: 'medium',
      });
    }

    // 3. City-level bias detection
    for (const [city, stats] of Object.entries(this.getCityBreakdown(settled))) {
      if (stats.trades < MIN_CITY_TRADES) continue;
      const cityWinRate = stats.wins / stats.trades;
      if (cityWinRate < 0.30) {
        adjustments.push({
          parameter: `CITY_EXCLUDE_${city}`,
          currentValue: 0,
          recommendedValue: 1,
          reason: `${city} win rate ${(cityWinRate * 100).toFixed(0)}% over ${stats.trades} trades — consider excluding`,
          confidence: stats.trades >= 15 ? 'high' : 'medium',
        });
      }
    }

    // 4. Haiku validation quality
    const haikuApproved = settled.filter(t => t.haikuApproved);
    if (haikuApproved.length >= 10) {
      const haikuWinRate = haikuApproved.filter(t => t.outcome === 'win').length / haikuApproved.length;
      if (haikuWinRate < 0.40) {
        adjustments.push({
          parameter: 'HAIKU_CONFIDENCE_THRESHOLD',
          currentValue: 0,
          recommendedValue: 75,
          reason: `Haiku-approved trades win rate ${(haikuWinRate * 100).toFixed(0)}% — add minimum confidence threshold`,
          confidence: 'medium',
        });
      }
    }

    return adjustments;
  }

  private getCityBreakdown(trades: TradeRecord[]): Record<string, { trades: number; wins: number }> {
    const result: Record<string, { trades: number; wins: number }> = {};
    for (const t of trades) {
      if (!result[t.city]) result[t.city] = { trades: 0, wins: 0 };
      result[t.city].trades++;
      if (t.outcome === 'win') result[t.city].wins++;
    }
    return result;
  }

  getRecentTrades(limit = 20): TradeRecord[] {
    return this.trades.slice(-limit);
  }

  /** Get paper trade count vs real trade count */
  getModeSummary(): { paper: number; real: number; paperPnL: number; realPnL: number } {
    const paper = this.trades.filter(t => t.paperTrade);
    const real = this.trades.filter(t => !t.paperTrade);
    return {
      paper: paper.length,
      real: real.length,
      paperPnL: paper.reduce((sum, t) => sum + (t.pnl || 0), 0),
      realPnL: real.reduce((sum, t) => sum + (t.pnl || 0), 0),
    };
  }
}
