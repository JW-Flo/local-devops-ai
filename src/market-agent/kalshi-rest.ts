import { config } from '../config.js';

interface KalshiLoginResponse {
  token: string;
  member_id: string;
}

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

export class KalshiRest {
  private baseUrl: string;
  private token: string | null = null;
  private memberId: string | null = null;
  private tokenExpiry: number = 0;

  constructor() {
    const env = (config.kalshiBaseUrl?.includes('demo') ?? true) ? 'demo' : 'prod';
    this.baseUrl =
      env === 'prod'
        ? 'https://api.elections.kalshi.com/trade-api/v2'
        : 'https://demo-api.kalshi.co/trade-api/v2';
  }

  private async request<T>(method: string, path: string, body?: object): Promise<T> {
    await this.ensureAuth();

    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (res.status === 401) {
      this.token = null;
      await this.ensureAuth();
      headers['Authorization'] = `Bearer ${this.token}`;
      const retry = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!retry.ok) {
        const text = await retry.text();
        throw new Error(`Kalshi API ${method} ${path} failed: ${retry.status} ${text}`);
      }
      return retry.json() as T;
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Kalshi API ${method} ${path} failed: ${res.status} ${text}`);
    }

    return res.json() as T;
  }

  private async ensureAuth(): Promise<void> {
    if (this.token && Date.now() < this.tokenExpiry) return;

    console.log('Authenticating with Kalshi API');
    const res = await fetch(`${this.baseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: config.kalshiEmail,
        password: config.kalshiPassword,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Kalshi login failed: ${res.status} ${text}`);
    }

    const data = (await res.json()) as KalshiLoginResponse;
    this.token = data.token;
    this.memberId = data.member_id;
    this.tokenExpiry = Date.now() + 55 * 60 * 1000;
    console.log(`Kalshi authenticated: ${this.memberId}`);
  }

  getToken(): string | null {
    return this.token;
  }

  getMemberId(): string | null {
    return this.memberId;
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