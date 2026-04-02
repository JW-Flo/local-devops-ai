import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { config } from '../config.js';

interface WSMessage {
  id?: number;
  type: string;
  msg?: Record<string, unknown>;
  cmd?: string;
  params?: Record<string, unknown>;
}

export interface OrderbookDelta {
  market_ticker: string;
  yes: Array<[number, number]>;
  no: Array<[number, number]>;
}

export interface TradeTick {
  market_ticker: string;
  count: number;
  yes_price: number;
  taker_side: string;
  created_time: string;
}

/**
 * Real-time bid/ask from the `ticker` channel.
 * Values are in dollars (not cents), matching REST orderbook price format.
 * Emitted for ALL subscribed markets without needing per-market subscriptions.
 */
export interface TickerUpdate {
  market_ticker: string;
  yes_bid_dollars: number;
  yes_ask_dollars: number;
  yes_bid_size?: number;
  yes_ask_size?: number;
  volume?: number;
  open_interest?: number;
}

export class KalshiWebSocket extends EventEmitter {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectDelay = 60000;
  private pingInterval: NodeJS.Timeout | null = null;
  private msgId = 1;
  private getAuthHeaders: () => Record<string, string>;
  /** Per-market tickers subscribed to orderbook_delta + trade */
  private marketSubscriptions: string[] = [];
  /** Whether we've sent the global ticker channel subscription */
  private tickerSubscribed = false;
  private _connected = false;

  constructor(getAuthHeaders: () => Record<string, string>) {
    super();
    this.getAuthHeaders = getAuthHeaders;
  }

  get connected(): boolean {
    return this._connected;
  }

  async connect(): Promise<void> {
    const authHeaders = this.getAuthHeaders();
    if (!authHeaders || Object.keys(authHeaders).length === 0) {
      console.warn('No auth headers available for WebSocket');
      this.scheduleReconnect();
      return;
    }

    const isDemo = config.kalshiBaseUrl?.includes('demo') ?? false;
    const wsUrl = isDemo
      ? 'wss://demo-api.kalshi.co/trade-api/ws/v2'
      : 'wss://api.elections.kalshi.com/trade-api/ws/v2';

    console.log(`Connecting Kalshi WebSocket to ${wsUrl}`);

    return new Promise((resolve) => {
      this.ws = new WebSocket(wsUrl, {
        headers: authHeaders,
      });

      this.ws.on('open', () => {
        this._connected = true;
        this.reconnectAttempts = 0;
        this.tickerSubscribed = false;
        console.log('Kalshi WebSocket connected');
        this.emit('connected');
        this.startPing();

        // Subscribe to global ticker channel first — no market_tickers needed,
        // broadcasts real-time bid/ask for all markets (public channel, no per-market auth)
        this.sendTickerSubscribe();

        // Re-subscribe to any previously registered market orderbooks
        for (const ticker of this.marketSubscriptions) {
          this.sendOrderbookSubscribe(ticker);
        }

        resolve();
      });

      this.ws.on('message', (data: Buffer) => {
        try {
          this.handleMessage(data.toString());
        } catch (err) {
          console.error('WebSocket message parse error:', err);
        }
      });

      this.ws.on('close', (code, reason) => {
        this._connected = false;
        this.tickerSubscribed = false;
        this.stopPing();
        console.warn(`Kalshi WebSocket closed: code=${code} reason=${reason.toString()}`);
        this.emit('disconnected');
        this.scheduleReconnect();
      });

      this.ws.on('error', (err) => {
        console.error('Kalshi WebSocket error:', err);
      });

      setTimeout(() => {
        if (!this._connected) {
          console.warn('WebSocket connection timeout');
          this.ws?.terminate();
          resolve();
        }
      }, 10000);
    });
  }

  private handleMessage(raw: string): void {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'orderbook_snapshot':
      case 'orderbook_delta':
        this.emit('orderbook_delta', msg.msg as unknown as OrderbookDelta);
        break;

      case 'trade':
        this.emit('trade', msg.msg as unknown as TradeTick);
        break;

      case 'ticker': {
        const m = msg.msg as Record<string, unknown>;
        const update: TickerUpdate = {
          market_ticker: m.market_ticker as string,
          yes_bid_dollars: Number(m.yes_bid_dollars ?? 0),
          yes_ask_dollars: Number(m.yes_ask_dollars ?? 0),
          yes_bid_size: m.yes_bid_size != null ? Number(m.yes_bid_size) : undefined,
          yes_ask_size: m.yes_ask_size != null ? Number(m.yes_ask_size) : undefined,
          volume: m.volume != null ? Number(m.volume) : undefined,
          open_interest: m.open_interest != null ? Number(m.open_interest) : undefined,
        };
        this.emit('ticker_update', update);
        break;
      }

      case 'fill':
        this.emit('fill', msg.msg);
        break;

      case 'subscribed':
        console.log(`Subscribed to channel: ${JSON.stringify(msg.msg)}`);
        if ((msg.msg as any)?.channels?.includes('ticker')) {
          this.tickerSubscribed = true;
        }
        break;

      case 'error':
        console.error('WebSocket server error:', msg.msg);
        break;

      default:
        break;
    }
  }

  /**
   * Subscribe to real-time orderbook + trade for specific market tickers.
   * Separate from the global ticker channel which is subscribed automatically.
   */
  subscribe(tickers: string[]): void {
    for (const ticker of tickers) {
      if (!this.marketSubscriptions.includes(ticker)) {
        this.marketSubscriptions.push(ticker);
      }
      if (this._connected) {
        this.sendOrderbookSubscribe(ticker);
      }
    }
  }

  unsubscribe(tickers: string[]): void {
    this.marketSubscriptions = this.marketSubscriptions.filter((t) => !tickers.includes(t));
    if (this._connected) {
      for (const ticker of tickers) {
        this.sendOrderbookUnsubscribe(ticker);
      }
    }
  }

  /**
   * Global ticker channel — public, no market_tickers param needed.
   * Broadcasts live bid/ask for every market on the platform.
   */
  private sendTickerSubscribe(): void {
    this.send({
      id: this.msgId++,
      cmd: 'subscribe',
      params: {
        channels: ['ticker'],
      },
    });
  }

  private sendOrderbookSubscribe(ticker: string): void {
    this.send({
      id: this.msgId++,
      cmd: 'subscribe',
      params: {
        channels: ['orderbook_delta', 'trade'],
        market_tickers: [ticker],
      },
    });
  }

  private sendOrderbookUnsubscribe(ticker: string): void {
    this.send({
      id: this.msgId++,
      cmd: 'unsubscribe',
      params: {
        channels: ['orderbook_delta', 'trade'],
        market_tickers: [ticker],
      },
    });
  }

  private send(msg: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private startPing(): void {
    this.stopPing();
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, 30000);
  }

  private stopPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private scheduleReconnect(): void {
    this.reconnectAttempts++;
    const delay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempts - 1),
      this.maxReconnectDelay
    );
    console.log(`Scheduling WebSocket reconnect in ${delay}ms (attempt ${this.reconnectAttempts})`);
    setTimeout(() => this.connect(), delay);
  }

  disconnect(): void {
    this.stopPing();
    this._connected = false;
    this.tickerSubscribed = false;
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
  }
}
