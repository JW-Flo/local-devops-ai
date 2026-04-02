import { EventEmitter } from 'events';
import type { Database } from 'sql.js';
import { KalshiWebSocket, OrderbookDelta, TradeTick, TickerUpdate } from './kalshi-ws.js';
import { KalshiRest } from './kalshi-rest.js';
import { OrderbookState } from './orderbook.js';
import { config } from '../config.js';
import { withDb } from '../storage/sqlite.js';

const RECONCILE_MS = 5 * 60_000;   // 5 min reconciliation
const REST_FALLBACK_MS = 30_000;   // 30s REST fallback polling

export class KalshiFeed extends EventEmitter {
  private ws: KalshiWebSocket;
  private rest: KalshiRest;
  private orderbook: OrderbookState;
  private restFallbackTimer: NodeJS.Timeout | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private marketTickers: string[] = [];
  /** Latest ticker bid/ask from WS ticker channel — dollars, updated in real-time */
  private tickerCache: Map<string, TickerUpdate> = new Map();

  constructor(rest: KalshiRest) {
    super();
    this.rest = rest;
    this.orderbook = new OrderbookState();
    this.ws = new KalshiWebSocket(() => rest.getWsAuthHeaders());
  }

  getOrderbook(): OrderbookState {
    return this.orderbook;
  }

  async start(): Promise<void> {
    await this.discoverMarkets();

    this.ws.on('connected', () => {
      this.stopRestFallback();
      withDb(async (db: Database) => {
        db.run(`INSERT INTO events (event_type, timestamp_ms, payload) VALUES (?, ?, ?)`, [
          'ws_connected',
          Date.now(),
          JSON.stringify({}),
        ]);
      }, { db: 'market-agent', persist: true });
      this.emit('ws_connected');
    });

    this.ws.on('disconnected', () => {
      withDb(async (db: Database) => {
        db.run(`INSERT INTO events (event_type, timestamp_ms, payload) VALUES (?, ?, ?)`, [
          'ws_disconnected',
          Date.now(),
          JSON.stringify({}),
        ]);
      }, { db: 'market-agent', persist: true });
      this.startRestFallback();
      this.emit('ws_disconnected');
    });

    this.ws.on('orderbook_delta', (delta: OrderbookDelta) => {
      this.orderbook.applyDelta(delta);
      this.emit('orderbook_update', delta.market_ticker);
    });

    this.ws.on('trade', (trade: TradeTick) => {
      this.emit('trade', trade);
    });

    this.ws.on('fill', (fill: Record<string, unknown>) => {
      this.emit('fill', fill);
    });

    this.ws.on('ticker_update', (update: TickerUpdate) => {
      this.tickerCache.set(update.market_ticker, update);
      this.emit('ticker_update', update);
    });

    await this.ws.connect();

    if (this.marketTickers.length > 0) {
      this.ws.subscribe(this.marketTickers);
    }

    this.reconcileTimer = setInterval(() => this.reconcile(), RECONCILE_MS);
    setInterval(() => this.discoverMarkets(), 15 * 60 * 1000);

    console.log(`Kalshi feed started with ${this.marketTickers.length} markets`);
  }

  async discoverMarkets(): Promise<void> {
    try {
      const markets = await this.rest.getWeatherMarkets();
      const newTickers = markets.map((m) => m.ticker).filter((t) => !this.marketTickers.includes(t));

      if (newTickers.length > 0) {
        this.marketTickers.push(...newTickers);
        if (this.ws.connected) {
          this.ws.subscribe(newTickers);
        }
        console.log(`New markets discovered: ${newTickers.length} (total: ${this.marketTickers.length})`);
      }
    } catch (err) {
      console.error('Market discovery failed:', err);
    }
  }

  private startRestFallback(): void {
    if (this.restFallbackTimer) return;
    console.log('Starting REST fallback polling');

    this.restFallbackTimer = setInterval(async () => {
      if (this.ws.connected) {
        this.stopRestFallback();
        return;
      }
      await this.fetchAllOrderbooks();
    }, REST_FALLBACK_MS);

    this.fetchAllOrderbooks();
  }

  private stopRestFallback(): void {
    if (this.restFallbackTimer) {
      clearInterval(this.restFallbackTimer);
      this.restFallbackTimer = null;
      console.log('REST fallback stopped — WebSocket reconnected');
    }
  }

  private async fetchAllOrderbooks(): Promise<void> {
    for (const ticker of this.marketTickers) {
      try {
        const ob = await this.rest.getOrderbook(ticker);
        this.orderbook.applySnapshot(ticker, ob);
        this.emit('orderbook_update', ticker);
      } catch (err) {
        console.warn(`REST orderbook fetch failed for ${ticker}:`, err);
      }
    }
  }

  private async reconcile(): Promise<void> {
    if (!this.ws.connected) return;

    console.log('Running orderbook reconciliation');
    let reconciled = 0;

    for (const ticker of this.marketTickers) {
      try {
        const ob = await this.rest.getOrderbook(ticker);
        this.orderbook.applySnapshot(ticker, ob);
        reconciled++;
      } catch (err) {
        console.warn(`Reconciliation fetch failed for ${ticker}:`, err);
      }
    }

    for (const ticker of this.marketTickers) {
      const book = this.orderbook.getBook(ticker);
      if (book) {
        await withDb(async (db: Database) => {
          db.run(
            `INSERT INTO events (event_type, timestamp_ms, market_ticker, payload) VALUES (?, ?, ?, ?)`,
            [
              'orderbook_snapshot',
              Date.now(),
              ticker,
              JSON.stringify({
                ticker,
                yes_bid: book.yesBids[0]?.price || 0,
                yes_ask: book.yesAsks[0]?.price || 0,
                yes_bid_size: book.yesBids[0]?.size || 0,
                yes_ask_size: book.yesAsks[0]?.size || 0,
              }),
            ]
          );
        }, { db: 'market-agent' });
      }
    }

    console.log(`Reconciliation complete: ${reconciled}/${this.marketTickers.length}`);
  }

  getMarketTickers(): string[] {
    return [...this.marketTickers];
  }

  /** Latest real-time bid/ask from ticker channel, keyed by market ticker */
  getTickerSnapshot(): Map<string, TickerUpdate> {
    return this.tickerCache;
  }

  /** Get bid/ask for a specific ticker (undefined if no data yet) */
  getTickerBidAsk(ticker: string): TickerUpdate | undefined {
    return this.tickerCache.get(ticker);
  }

  isWebSocketConnected(): boolean {
    return this.ws.connected;
  }

  stop(): void {
    this.stopRestFallback();
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    this.ws.disconnect();
    console.log('Kalshi feed stopped');
  }
}