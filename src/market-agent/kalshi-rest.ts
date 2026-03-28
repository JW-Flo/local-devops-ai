import crypto from 'crypto';
import { readFileSync } from 'fs';
import { config } from '../config.js';

// ── RSA-PSS per-request signing for Kalshi API v2 ──

const KALSHI_KEY_ID = process.env.KALSHI_API_KEY_ID ?? '';
const KALSHI_PRIVATE_KEY_PATH = process.env.KALSHI_PRIVATE_KEY_PATH ?? '';

let privateKeyPem: string | null = null;

function getPrivateKey(): string {
  if (!privateKeyPem) {
    if (!KALSHI_PRIVATE_KEY_PATH) throw new Error('KALSHI_PRIVATE_KEY_PATH not set');
    privateKeyPem = readFileSync(KALSHI_PRIVATE_KEY_PATH, 'utf-8');
  }
  return privateKeyPem;
}

function signRequest(method: string, path: string): Record<string, string> {
  const ts = Date.now();
  const cleanPath = path.split('?')[0];
  const message = `${ts}${method.toUpperCase()}${cleanPath}`;

  const signature = crypto.sign('sha256', Buffer.from(message), {
    key: getPrivateKey(),
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32,
  });

  return {
    'KALSHI-ACCESS-KEY': KALSHI_KEY_ID,
    'KALSHI-ACCESS-TIMESTAMP': ts.toString(),
    'KALSHI-ACCESS-SIGNATURE': signature.toString('base64'),
    'Content-Type': 'application/json',
  };
}

// ── Types ──

interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  title: string;
  subtitle: string;
  status: string;
  yes_bid: number;
  yes_ask: number;
  volume: number;
  open_interest: number;
  floor_strike?: number;
  cap_strike?: number;
}

interface KalshiOrderRequest {
  ticker: string;
  side: 'yes' | 'no';
  type: 'market' | 'limit';
  action: 'buy' | 'sell';
  count: number;
  yes_price?: number;
  no_price?: number;
}

interface KalshiOrder {
  order_id: string;
  ticker: string;
  status: string;
  side: string;
  action: string;
  count: number;
  yes_price: number;
  created_time: string;
}

interface KalshiPosition {
  ticker: string;
  market_exposure: number;
  position: number;
  realized_pnl: number;
  total_traded: number;
}

// ── Client ──

export class KalshiRest {
  private baseUrl: string;

  constructor() {
    this.baseUrl = config.kalshiBaseUrl?.includes('demo')
      ? 'https://demo-api.kalshi.co/trade-api/v2'
      : 'https://trading-api.kalshi.com/trade-api/v2';
  }

  private async request<T>(method: string, path: string, body?: object): Promise<T> {
    const fullPath = `/trade-api/v2${path}`;
    const url = `${this.baseUrl}${path}`;
    const headers = signRequest(method, fullPath);

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (res.status === 401) {
      // RSA signing doesn't need re-auth — likely clock skew or bad key
      const text = await res.text();
      throw new Error(`Kalshi 401 (check key/clock): ${method} ${path} — ${text}`);
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Kalshi API ${method} ${path} failed: ${res.status} ${text}`);
    }

    return res.json() as T;
  }

  // Kept for backward compat with KalshiFeed / KalshiWs
  getToken(): string | null {
    return KALSHI_KEY_ID || null;
  }

  getMemberId(): string | null {
    return KALSHI_KEY_ID || null;
  }

  async getWeatherMarkets(): Promise<KalshiMarket[]> {
    const markets: KalshiMarket[] = [];
    const seriesTickers = ['KXHIGHNY', 'KXHIGHLAX', 'KXHIGHCHI', 'KXHIGHMIA', 'KXHIGHDFW'];

    for (const series of seriesTickers) {
      try {
        const params = new URLSearchParams({
          series_ticker: series,
          status: 'open',
          limit: '100',
        });

        const data = await this.request<{ markets: KalshiMarket[]; cursor?: string }>(
          'GET',
          `/markets?${params.toString()}`
        );
        markets.push(...data.markets);
      } catch (err) {
        console.warn(`Failed to fetch markets for series ${series}:`, err);
      }
    }

    return markets;
  }

  async getOrderbook(ticker: string): Promise<{
    yes: Array<{ price: number; quantity: number }>;
    no: Array<{ price: number; quantity: number }>;
  }> {
    const data = await this.request<{
      orderbook: {
        yes: Array<[number, number]>;
        no: Array<[number, number]>;
      };
    }>('GET', `/markets/${ticker}/orderbook`);

    return {
      yes: (data.orderbook.yes || []).map(([price, quantity]) => ({ price: price / 100, quantity })),
      no: (data.orderbook.no || []).map(([price, quantity]) => ({ price: price / 100, quantity })),
    };
  }

  async createOrder(order: KalshiOrderRequest) {
    const body: Record<string, unknown> = {
      ticker: order.ticker,
      action: order.action || 'buy',
      side: order.side,
      type: order.type,
      count: order.count,
    };
    if (order.yes_price !== undefined) body.yes_price = order.yes_price;
    if (order.no_price !== undefined) body.no_price = order.no_price;

    const data = await this.request<{ order: KalshiOrder }>('POST', '/portfolio/orders', body);
    console.log(`Order placed: ${data.order.order_id} for ${order.ticker}`);
    return data.order;
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.request('DELETE', `/portfolio/orders/${orderId}`);
    console.log(`Order cancelled: ${orderId}`);
  }

  async getPositions(): Promise<KalshiPosition[]> {
    const data = await this.request<{
      market_positions: KalshiPosition[];
    }>('GET', '/portfolio/positions');
    return data.market_positions || [];
  }

  async getBalance(): Promise<number> {
    const data = await this.request<{ balance: number }>('GET', '/portfolio/balance');
    return data.balance / 100;
  }

  async getOpenOrders(): Promise<KalshiOrder[]> {
    const data = await this.request<{ orders: KalshiOrder[] }>(
      'GET',
      '/portfolio/orders?status=resting'
    );
    return data.orders || [];
  }
}
