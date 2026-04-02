import type { Database } from 'sql.js';
import { KalshiRest } from './kalshi-rest.js';
import { SafetyGuard } from './safety.js';
import { MispricingSignal, TradeValidation, TradeExecutedPayload } from './types.js';
import { validateWithHaiku } from './ensemble.js';
import { notify } from './notifications.js';
import { withDb } from '../storage/sqlite.js';
import { PerformanceTracker } from './performance.js';
import type { TickerUpdate } from './kalshi-ws.js';

export class OrderExecutor {
  private rest: KalshiRest;
  private safety: SafetyGuard;
  private pendingOrders: Set<string> = new Set();
  private executedTickers: Map<string, number> = new Map(); // ticker -> timestamp
  private validationCache: Map<string, TradeValidation> = new Map(); // ticker -> cached result
  private performance: PerformanceTracker;
  private _paperMode: boolean;

  constructor(rest: KalshiRest, safety: SafetyGuard, paperMode = true) {
    this.rest = rest;
    this.safety = safety;
    this._paperMode = paperMode;
    this.performance = new PerformanceTracker();
  }

  get paperMode(): boolean { return this._paperMode; }
  set paperMode(v: boolean) {
    this._paperMode = v;
    console.log(`[orders] Trading mode: ${v ? 'PAPER' : 'LIVE'}`);
  }

  getPerformance(): PerformanceTracker { return this.performance; }

  async init(): Promise<void> {
    await this.performance.initialize();
  }

  /** Clear executed ticker history (call on bot restart or new trading day) */
  resetExecutedTickers(): void {
    this.executedTickers.clear();
  }

  /** Mark a ticker as already executed (used when syncing positions on startup) */
  markAsExecuted(ticker: string): void {
    this.executedTickers.set(ticker, Date.now());
  }

  async execute(signal: MispricingSignal, bankroll: number, tickerCache?: Map<string, TickerUpdate>): Promise<boolean> {
    if (this.pendingOrders.has(signal.ticker)) {
      console.log(`Order already pending for ${signal.ticker}`);
      return false;
    }

    if (this.executedTickers.has(signal.ticker)) {
      return false; // silently skip — already traded or rejected this ticker this session
    }

    const safetyCheck = this.safety.checkPreTrade(signal, bankroll);
    if (!safetyCheck.passed) {
      console.warn(`Trade blocked by safety for ${signal.ticker}: ${safetyCheck.reason}`);
      await withDb(async (db: Database) => {
        db.run(
          `INSERT INTO events (event_type, timestamp_ms, market_ticker, payload) VALUES (?, ?, ?, ?)`,
          [
            'trade_rejected',
            Date.now(),
            signal.ticker,
            JSON.stringify({ reason: safetyCheck.reason, signal }),
          ]
        );
      }, { db: 'market-agent', persist: true });
      return false;
    }

    // In paper mode, skip Haiku validation — auto-approve so paper trades flow
    // Haiku still validates in live mode where real money is at risk
    let validation: TradeValidation;
    if (this._paperMode) {
      validation = { approved: true, confidence: 0, reasoning: 'Paper mode — Haiku bypassed' };
    } else {
      // Use cached validation if available — Haiku with temp=0 is deterministic for same inputs
      const cached = this.validationCache.get(signal.ticker);
      if (cached) {
        validation = cached;
      } else {
        try {
          validation = await validateWithHaiku(signal);
          this.validationCache.set(signal.ticker, validation);
        } catch (err) {
          console.error(`Haiku validation error for ${signal.ticker}:`, err);
          return false;
        }
      }

      if (!validation.approved) {
        console.log(`Trade rejected by Haiku for ${signal.ticker}: ${validation.reasoning}`);
        this.executedTickers.set(signal.ticker, Date.now()); // Don't re-evaluate rejected tickers
        await withDb(async (db: Database) => {
          db.run(
            `INSERT INTO events (event_type, timestamp_ms, market_ticker, payload) VALUES (?, ?, ?, ?)`,
            [
              'trade_rejected',
              Date.now(),
              signal.ticker,
              JSON.stringify({
                reason: `Haiku rejected: ${validation.reasoning}`,
                signal,
                validation,
              }),
            ]
          );
        }, { db: 'market-agent', persist: true });
        return false;
      }
    }

    this.pendingOrders.add(signal.ticker);
    try {
      let orderId: string;
      let filledCount: number;

      const tradeSide = signal.side || 'yes';
      const tradeAction = signal.action || 'buy';

      if (this._paperMode) {
        // Paper trade: simulate realistic fill capped to available liquidity
        orderId = `paper-${Date.now()}-${signal.ticker}-${tradeSide}`;
        let availableSize = signal.recommendedContracts; // default: use signal's already-capped count
        if (tickerCache) {
          const snap = tickerCache.get(signal.ticker);
          if (snap) {
            // YES-BUY: limited by ask size. NO-BUY: limited by bid size (we're buying the other side)
            availableSize = tradeSide === 'yes'
              ? Number(snap.yes_ask_size || 0)
              : Number(snap.yes_bid_size || 0);
          }
        }
        filledCount = Math.min(signal.recommendedContracts, Math.max(0, availableSize));
        if (filledCount <= 0) {
          console.log(`[PAPER] Skipped ${signal.ticker} — zero liquidity at best price`);
          return false;
        }
        console.log(`[PAPER] Simulated ${tradeSide.toUpperCase()}-${tradeAction.toUpperCase()}: ${orderId} | ${signal.ticker} | ${filledCount}@$${signal.marketPrice.toFixed(2)} (avail: ${availableSize})`);
      } else {
        // Live trade: place real order on Kalshi
        const orderReq: any = {
          ticker: signal.ticker,
          side: tradeSide,
          type: 'limit',
          action: tradeAction,
          count: signal.recommendedContracts,
        };
        // Kalshi API: yes_price for YES orders, no_price for NO orders (in cents)
        if (tradeSide === 'yes') {
          orderReq.yes_price = Math.round(signal.marketPrice * 100);
        } else {
          orderReq.no_price = Math.round(signal.marketPrice * 100);
        }
        const order = await this.rest.createOrder(orderReq);
        orderId = order.order_id;

        // Check fill status — Kalshi limit orders may partially fill
        filledCount = order.status === 'executed'
          ? signal.recommendedContracts
          : (order as any).remaining_count !== undefined
            ? signal.recommendedContracts - (order as any).remaining_count
            : signal.recommendedContracts;

        if (filledCount <= 0) {
          console.warn(`Order ${orderId} for ${signal.ticker} is resting (unfilled) — cancelling`);
          try { await this.rest.cancelOrder(orderId); } catch {}
          return false;
        }
      }

      this.safety.recordTrade(signal.ticker, filledCount, signal.marketPrice);
      this.executedTickers.set(signal.ticker, Date.now());

      // Record in performance tracker
      await this.performance.recordTrade(
        signal, signal.marketPrice, validation.approved, validation.confidence, this._paperMode
      );

      const modeTag = this._paperMode ? '[PAPER] ' : '';
      const payload: TradeExecutedPayload = {
        order_id: orderId,
        ticker: signal.ticker,
        side: tradeSide as 'buy' | 'sell',
        quantity: filledCount,
        price: signal.marketPrice,
        total_cost: filledCount * signal.marketPrice,
        rationale: `${modeTag}${tradeSide.toUpperCase()}-BUY | NOAA ${signal.noaaForecastF}°F, prob ${(signal.noaaConfidence * 100).toFixed(1)}%, ` +
          `edge $${signal.edge.toFixed(3)}, Kelly ${signal.kellyFraction.toFixed(3)}`,
      };

      await withDb(async (db: Database) => {
        db.run(
          `INSERT INTO events (event_type, timestamp_ms, market_ticker, payload) VALUES (?, ?, ?, ?)`,
          [this._paperMode ? 'paper_trade' : 'trade_executed', Date.now(), signal.ticker, JSON.stringify(payload)]
        );
      }, { db: 'market-agent', persist: true });

      await notify(
        `${modeTag}${tradeSide.toUpperCase()}-BUY: ${signal.ticker}\n` +
        `${filledCount} contracts @ $${signal.marketPrice.toFixed(2)}\n` +
        `NOAA: ${signal.noaaForecastF}°F → bucket [${signal.bucketRange[0]},${signal.bucketRange[1]}]\n` +
        `Edge: $${signal.edge.toFixed(3)} | Kelly: ${(signal.kellyFraction * 100).toFixed(1)}%`
      );

      console.log(
        `${modeTag}Trade executed: ${orderId} | ${signal.ticker} | ` +
        `${filledCount}@$${signal.marketPrice.toFixed(2)}`
      );

      return true;
    } catch (err) {
      console.error(`Order placement failed for ${signal.ticker}:`, err);
      await notify(`Order FAILED: ${signal.ticker} — execution error`, 'error');
      return false;
    } finally {
      this.pendingOrders.delete(signal.ticker);
    }
  }

  async cancelAll(): Promise<void> {
    try {
      const orders = await this.rest.getOpenOrders();
      for (const order of orders) {
        await this.rest.cancelOrder(order.order_id);
        console.log(`Order cancelled: ${order.order_id}`);
      }
      await notify(`Cancelled ${orders.length} open orders`, 'warn');
    } catch (err) {
      console.error('Failed to cancel orders:', err);
    }
  }
}