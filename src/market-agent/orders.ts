import type { Database } from 'sql.js';
import { KalshiRest } from './kalshi-rest.js';
import { SafetyGuard } from './safety.js';
import { MispricingSignal, TradeValidation, TradeExecutedPayload } from './types.js';
import { validateWithHaiku } from './ensemble.js';
import { notify } from './notifications.js';
import { withDb } from '../storage/sqlite.js';
import { config } from '../config.js';

export class OrderExecutor {
  private rest: KalshiRest;
  private safety: SafetyGuard;
  private pendingOrders: Set<string> = new Set();
  private simTradeCount = 0;

  constructor(rest: KalshiRest, safety: SafetyGuard) {
    this.rest = rest;
    this.safety = safety;
  }

  async execute(signal: MispricingSignal, bankroll: number): Promise<boolean> {
    if (this.pendingOrders.has(signal.ticker)) {
      console.log(`Order already pending for ${signal.ticker}`);
      return false;
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

    let validation: TradeValidation;
    try {
      validation = await validateWithHaiku(signal);
    } catch (err) {
      console.error(`Haiku validation error for ${signal.ticker}:`, err);
      return false;
    }

    if (!validation.approved) {
      console.log(`Trade rejected by Haiku for ${signal.ticker}: ${validation.reasoning}`);
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

    this.pendingOrders.add(signal.ticker);
    try {
      const rationale =
        `NOAA ${signal.noaaForecastF}°F, prob ${(signal.noaaConfidence * 100).toFixed(1)}%, ` +
        `edge $${signal.edge.toFixed(3)}, Kelly ${signal.kellyFraction.toFixed(3)}`;

      // ── DRY RUN: log everything, skip Kalshi API ──
      if (config.marketDryRun) {
        this.simTradeCount++;
        const simOrderId = `SIM-${this.simTradeCount.toString().padStart(4, '0')}`;
        this.safety.recordTrade(signal.ticker, signal.recommendedContracts, signal.marketPrice);

        const payload: TradeExecutedPayload = {
          order_id: simOrderId,
          ticker: signal.ticker,
          side: 'buy',
          quantity: signal.recommendedContracts,
          price: signal.marketPrice,
          total_cost: signal.recommendedContracts * signal.marketPrice,
          rationale,
        };

        await withDb(async (db: Database) => {
          db.run(
            `INSERT INTO events (event_type, timestamp_ms, market_ticker, payload) VALUES (?, ?, ?, ?)`,
            ['trade_simulated', Date.now(), signal.ticker, JSON.stringify(payload)]
          );
        }, { db: 'market-agent', persist: true });

        console.log(
          `[DRY RUN] ${simOrderId} | ${signal.ticker} | ` +
          `${signal.recommendedContracts}@$${signal.marketPrice.toFixed(2)} | ${rationale}`
        );

        return true;
      }

      // ── LIVE: place real order via Kalshi API ──
      const order = await this.rest.createOrder({
        ticker: signal.ticker,
        side: 'yes',
        type: 'limit',
        action: 'buy',
        count: signal.recommendedContracts,
        yes_price: Math.round(signal.marketPrice * 100),
      });

      this.safety.recordTrade(signal.ticker, signal.recommendedContracts, signal.marketPrice);

      const payload: TradeExecutedPayload = {
        order_id: order.order_id,
        ticker: signal.ticker,
        side: 'buy',
        quantity: signal.recommendedContracts,
        price: signal.marketPrice,
        total_cost: signal.recommendedContracts * signal.marketPrice,
        rationale,
      };

      await withDb(async (db: Database) => {
        db.run(
          `INSERT INTO events (event_type, timestamp_ms, market_ticker, payload) VALUES (?, ?, ?, ?)`,
          ['trade_executed', Date.now(), signal.ticker, JSON.stringify(payload)]
        );
      }, { db: 'market-agent', persist: true });

      await notify(
        `Trade: ${signal.ticker}\n` +
        `${signal.recommendedContracts} contracts @ $${signal.marketPrice.toFixed(2)}\n` +
        `NOAA: ${signal.noaaForecastF}°F → bucket [${signal.bucketRange[0]},${signal.bucketRange[1]}]\n` +
        `Edge: $${signal.edge.toFixed(3)} | Kelly: ${(signal.kellyFraction * 100).toFixed(1)}%`
      );

      console.log(
        `Trade executed: ${order.order_id} | ${signal.ticker} | ` +
        `${signal.recommendedContracts}@$${signal.marketPrice.toFixed(2)}`
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