import { config } from '../config.js';
import { createSign, constants } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import dns from 'dns';

// Force Google DNS — local IPv6 resolver times out on first query
dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);

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

interface KalshiLoginResponse {
  token: string;
  member_id: string;
}

const PAGE_LIMIT = 100;

export class KalshiRest {
  private baseUrl: string;
  private token: string | null = null;
  private memberId: string | null = null;
  private tokenExpiry: number = 0;
  private rsaKey: string | null = null;
  private apiKeyId: string | null = null;
  private authMode: 'rsa' | 'password' = 'password';

  constructor() {
    this.baseUrl = config.kalshiBaseUrl || 'https://api.elections.kalshi.com/trade-api/v2';

    if (config.kalshiApiKeyId && config.kalshiRsaKeyPath) {
      try {
        const keyPath = resolve(process.cwd(), config.kalshiRsaKeyPath);
        this.rsaKey = readFileSync(keyPath, 'utf8');
        this.apiKeyId = config.kalshiApiKeyId;
        this.authMode = 'rsa';
        console.log(`[kalshi-rest] RSA key auth enabled (key ID: ${this.apiKeyId?.slice(0, 8)}...)`);
      } catch (err) {
        console.warn(`[kalshi-rest] Failed to load RSA key: ${(err as Error).message} — falling back to password auth`);
      }
    }
    console.log(`[kalshi-rest] base URL: ${this.baseUrl} (auth: ${this.authMode})`);
  }

  /**
   * RSA-PSS SHA-256 signing — exact spec from Kalshi API docs (JS section):
   *   createSign('RSA-SHA256') + update(text) + sign({ PSS, SALTLEN_DIGEST })
   *   message = timestampMs + METHOD + pathWithoutQuery
   */
  private signPssText(text: string): string {
    if (!this.rsaKey) throw new Error('RSA key not loaded');
    const sign = createSign('RSA-SHA256');
    sign.update(text);
    sign.end();
    return sign.sign({
      key: this.rsaKey,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
    }).toString('base64');
  }

  private getAuthHeaders(method: string, path: string): Record<string, string> {
    if (this.authMode === 'rsa' && this.rsaKey && this.apiKeyId) {
      const ts = String(Date.now());
      const pathWithoutQuery = path.split('?')[0];
      const msgString = ts + method.toUpperCase() + pathWithoutQuery;
      const sig = this.signPssText(msgString);
      return {
        'KALSHI-ACCESS-KEY': this.apiKeyId,
        'KALSHI-ACCESS-SIGNATURE': sig,
        'KALSHI-ACCESS-TIMESTAMP': ts,
      };
    }
    return this.token ? { Authorization: `Bearer ${this.token}` } : {};
  }

  /** For WebSocket connections — RSA signs GET on the ws path */
  getWsAuthHeaders(): Record<string, string> {
    return this.getAuthHeaders('GET', '/trade-api/ws/v2');
  }

  private async request<T>(method: string, path: string, body?: object): Promise<T> {
    if (this.authMode === 'password') await this.ensureAuth();

    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.getAuthHeaders(method, `/trade-api/v2${path}`),
    };

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (res.status === 401 && this.authMode === 'password') {
      this.token = null;
      await this.ensureAuth();
      const retryHeaders = {
        'Content-Type': 'application/json',
        ...this.getAuthHeaders(method, `/trade-api/v2${path}`),
      };
      const retry = await fetch(url, { method, headers: retryHeaders, body: body ? JSON.stringify(body) : undefined });
      if (!retry.ok) throw new Error(`Kalshi API ${method} ${path} failed: ${retry.status} ${await retry.text()}`);
      return retry.json() as T;
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Kalshi API ${method} ${path} failed: ${res.status} ${text}`);
    }
    return res.json() as T;
  }

  private async ensureAuth(): Promise<void> {
    if (this.authMode === 'rsa') return;
    if (this.token && Date.now() < this.tokenExpiry) return;

    const res = await fetch(`${this.baseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: config.kalshiEmail, password: config.kalshiPassword }),
    });
    if (!res.ok) throw new Error(`Kalshi login failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as KalshiLoginResponse;
    this.token = data.token;
    this.memberId = data.member_id;
    this.tokenExpiry = Date.now() + 55 * 60 * 1000;
    console.log(`Kalshi authenticated: ${this.memberId}`);
  }

  getToken(): string | null { return this.token; }
  getMemberId(): string | null { return this.memberId; }
  getAuthMode(): string { return this.authMode; }

  /**
   * Fetch all open weather markets using cursor-based pagination.
   * Loops until cursor is exhausted (no more pages).
   */
  async getWeatherMarkets(): Promise<KalshiMarket[]> {
    const markets: KalshiMarket[] = [];
    const seriesTickers = ['KXHIGHNY', 'KXHIGHLAX', 'KXHIGHCHI', 'KXHIGHMIA', 'KXHIGHDFW', 'KXHIGHDEN', 'KXHIGHAUS'];

    for (const series of seriesTickers) {
      try {
        let cursor: string | undefined;
        let page = 0;
        do {
          const params = new URLSearchParams({
            series_ticker: series,
            status: 'open',
            limit: String(PAGE_LIMIT),
          });
          if (cursor) params.set('cursor', cursor);

          const data = await this.request<{ markets: KalshiMarket[]; cursor?: string }>(
            'GET',
            `/markets?${params}`,
          );

          const batch = data.markets ?? [];
          markets.push(...batch);
          page++;

          // Advance cursor only if we got a full page — empty cursor or short page = done
          cursor = batch.length === PAGE_LIMIT && data.cursor ? data.cursor : undefined;
          if (page > 1) console.log(`[kalshi-rest] ${series} page ${page}: ${batch.length} markets (cursor=${cursor ? 'yes' : 'end'})`);
        } while (cursor);
      } catch (err) {
        console.warn(`Failed to fetch markets for series ${series}:`, err);
      }
    }

    return markets;
  }

  /**
   * Get a single market by ticker — used for settlement status checks.
   * Returns market object with status ('open', 'settled', 'closed') and result ('yes', 'no', null).
   */
  async getMarket(ticker: string): Promise<{ ticker: string; status: string; result: string | null; title: string } | null> {
    try {
      const data = await this.request<{ market: { ticker: string; status: string; result: string; title: string } }>('GET', `/markets/${ticker}`);
      return data.market;
    } catch (err) {
      console.warn(`[kalshi-rest] getMarket(${ticker}) failed: ${(err as Error).message}`);
      return null;
    }
  }

  async getOrderbook(ticker: string): Promise<{ yes: Array<{ price: number; quantity: number }>; no: Array<{ price: number; quantity: number }> }> {
    const data = await this.request<{ orderbook: { yes: Array<[number, number]>; no: Array<[number, number]> } }>('GET', `/markets/${ticker}/orderbook`);
    return {
      yes: (data.orderbook.yes || []).map(([price, quantity]) => ({ price: price / 100, quantity })),
      no: (data.orderbook.no || []).map(([price, quantity]) => ({ price: price / 100, quantity })),
    };
  }

  async createOrder(order: KalshiOrderRequest) {
    const body: Record<string, unknown> = {
      ticker: order.ticker, action: order.action || 'buy',
      side: order.side, type: order.type, count: order.count,
    };
    if (order.yes_price !== undefined) body.yes_price = order.yes_price;
    if (order.no_price !== undefined) body.no_price = order.no_price;
    const data = await this.request<{ order: KalshiOrder }>('POST', '/portfolio/orders', body);
    console.log(`Order placed: ${data.order.order_id} for ${order.ticker}`);
    return data.order;
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.request('DELETE', `/portfolio/orders/${orderId}`);
  }

  /**
   * Fetch all open portfolio positions with cursor pagination.
   */
  async getPositions(): Promise<KalshiPosition[]> {
    const positions: KalshiPosition[] = [];
    let cursor: string | undefined;
    do {
      const params = new URLSearchParams({ limit: String(PAGE_LIMIT) });
      if (cursor) params.set('cursor', cursor);

      const data = await this.request<{ market_positions: KalshiPosition[]; cursor?: string }>(
        'GET',
        `/portfolio/positions?${params}`,
      );

      const batch = data.market_positions ?? [];
      positions.push(...batch);
      cursor = batch.length === PAGE_LIMIT && data.cursor ? data.cursor : undefined;
    } while (cursor);

    return positions;
  }

  async getBalance(): Promise<number> {
    const data = await this.request<{ balance: number }>('GET', '/portfolio/balance');
    return data.balance / 100;
  }

  /**
   * Fetch all resting orders with cursor pagination.
   */
  async getOpenOrders(): Promise<KalshiOrder[]> {
    const orders: KalshiOrder[] = [];
    let cursor: string | undefined;
    do {
      const params = new URLSearchParams({ status: 'resting', limit: String(PAGE_LIMIT) });
      if (cursor) params.set('cursor', cursor);

      const data = await this.request<{ orders: KalshiOrder[]; cursor?: string }>(
        'GET',
        `/portfolio/orders?${params}`,
      );

      const batch = data.orders ?? [];
      orders.push(...batch);
      cursor = batch.length === PAGE_LIMIT && data.cursor ? data.cursor : undefined;
    } while (cursor);

    return orders;
  }
}
