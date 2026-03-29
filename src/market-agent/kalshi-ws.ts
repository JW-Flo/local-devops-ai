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

export class KalshiWebSocket extends EventEmitter {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectDelay = 60000;
  private pingInterval: NodeJS.Timeout | null = null;
  private msgId = 1;
  private getToken: () => string | null;
  private subscriptions: string[] = [];
  private _connected = false;

  constructor(getToken: () => string | null) {
    super();
    this.getToken = getToken;
  }

  get connected(): boolean {
    return this._connected;
  }

  async connect(): Promise<void> {
    const token = this.getToken();
    if (!token) {
      console.warn('No auth token available for WebSocket');
      this.scheduleReconnect();
      return;
    }

    const env = config.kalshiBaseUrl?.includes('demo') ?? true;
    const wsUrl = env
      ? 'wss://demo-api.kalshi.co/trade-api/ws/v2'
      : 'wss://api.elections.kalshi.com/trade-api/ws/v2';

    console.log(`Connecting Kalshi WebSocket to ${wsUrl}`);

    return new Promise((resolve) => {
      this.ws = new WebSocket(wsUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      this.ws.on('open', () => {
        this._connected = true;
        this.reconnectAttempts = 0;
        console.log('Kalshi WebSocket connected');
        this.emit('connected');
        this.startPing();

        for (const channel of this.subscriptions) {
          this.sendSubscribe(channel);
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

      case 'fill':
        this.emit('fill', msg.msg);
        break;

      case 'subscribed':
        console.log(`Subscribed to channel: ${JSON.stringify(msg.msg)}`);
        break;

      case 'error':
        console.error('WebSocket server error:', msg.msg);
        break;

      default:
        break;
    }
  }

  subscribe(tickers: string[]): void {
    for (const ticker of tickers) {
      if (!this.subscriptions.includes(ticker)) {
        this.subscriptions.push(ticker);
      }
      if (this._connected) {
        this.sendSubscribe(ticker);
      }
    }
  }

  unsubscribe(tickers: string[]): void {
    this.subscriptions = this.subscriptions.filter((t) => !tickers.includes(t));
    if (this._connected) {
      for (const ticker of tickers) {
        this.sendUnsubscribe(ticker);
      }
    }
  }

  private sendSubscribe(ticker: string): void {
    this.send({
      id: this.msgId++,
      cmd: 'subscribe',
      params: {
        channels: ['orderbook_delta', 'trade'],
        market_tickers: [ticker],
      },
    });
  }

  private sendUnsubscribe(ticker: string): void {
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
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
  }
}