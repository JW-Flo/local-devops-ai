import { Router, Request, Response } from 'express';
import type { Database } from 'sql.js';
import { config } from '../config.js';
import { withDb } from '../storage/sqlite.js';
import { NOAAClient } from './noaa.js';
import { KalshiRest } from './kalshi-rest.js';
import { KalshiFeed } from './kalshi-feed.js';
import { MispricingDetector } from './mispricing.js';
import { SafetyGuard } from './safety.js';
import { OrderExecutor } from './orders.js';
import { initNotifications, notify } from './notifications.js';
import { DailyForecast } from './types.js';

const CITIES = [
  { name: 'NYC', lat: 40.7831, lon: -73.9712, wfo: 'OKX', gridX: 33, gridY: 37, seriesTicker: 'KXHIGHNY' },
  { name: 'LA', lat: 34.0522, lon: -118.2437, wfo: 'LOX', gridX: 154, gridY: 44, seriesTicker: 'KXHIGHLAX' },
  { name: 'Chicago', lat: 41.8781, lon: -87.6298, wfo: 'LOT', gridX: 76, gridY: 73, seriesTicker: 'KXHIGHCHI' },
  { name: 'Miami', lat: 25.7617, lon: -80.1918, wfo: 'MFL', gridX: 109, gridY: 50, seriesTicker: 'KXHIGHMIA' },
  { name: 'Dallas', lat: 32.7767, lon: -96.7970, wfo: 'FWD', gridX: 79, gridY: 108, seriesTicker: 'KXHIGHDFW' },
];

export class MarketAgent {
  private noaa: NOAAClient;
  private kalshiRest: KalshiRest;
  private feed: KalshiFeed;
  private detector: MispricingDetector;
  private safety: SafetyGuard;
  private executor: OrderExecutor;
  private noaaTimer: NodeJS.Timeout | null = null;
  private bankroll = 0;
  private marketMeta: Map<string, { title: string; ticker: string }> = new Map();
  private running = false;

  constructor() {
    this.noaa = new NOAAClient();
    this.kalshiRest = new KalshiRest();
    this.feed = new KalshiFeed(this.kalshiRest);
    this.detector = new MispricingDetector();
    this.safety = new SafetyGuard();
    this.executor = new OrderExecutor(this.kalshiRest, this.safety);
  }

  async start(): Promise<void> {
    if (this.running) {
      console.log('Market Agent already running');
      return;
    }
    this.running = true;

    console.log('Starting Market Agent');

    await withDb(async (db: Database) => {
      db.run(
        `CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_type TEXT NOT NULL,
          timestamp_ms INTEGER NOT NULL,
          market_ticker TEXT,
          payload TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`
      );
    }, { db: 'market-agent', persist: true });

    initNotifications(config.discordWebhookUrl || '');

    await withDb(async (db: Database) => {
      db.run(
        `INSERT INTO events (event_type, timestamp_ms, payload) VALUES (?, ?, ?)`,
        ['bot_started', Date.now(), JSON.stringify({ env: 'gateway' })]
      );
    }, { db: 'market-agent', persist: true });

    try {
      this.bankroll = await this.kalshiRest.getBalance();
      console.log(`Initial balance: $${this.bankroll.toFixed(2)}`);
    } catch (err) {
      console.error('Failed to fetch balance:', err);
    }

    await this.feed.start();

    this.feed.on('orderbook_update', (ticker: string) => {
      this.onOrderbookUpdate(ticker);
    });

    await this.pollNOAA();
    this.noaaTimer = setInterval(() => this.pollNOAA(), 30 * 60 * 1000);

    await this.refreshMarketMeta();
    setInterval(() => this.refreshMarketMeta(), 15 * 60 * 1000);

    await notify(`Bot started | Bankroll: $${this.bankroll.toFixed(2)}`);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;

    console.log('Stopping Market Agent');
    if (this.noaaTimer) clearInterval(this.noaaTimer);
    this.feed.stop();

    withDb(async (db: Database) => {
      db.run(
        `INSERT INTO events (event_type, timestamp_ms, payload) VALUES (?, ?, ?)`,
        ['bot_stopped', Date.now(), JSON.stringify({})]
      );
    }, { db: 'market-agent', persist: true });

    notify('Bot stopped', 'warn');
  }

  private async pollNOAA(): Promise<void> {
    try {
      await this.noaa.pollAll();
      this.runFullScan();
    } catch (err) {
      console.error('NOAA poll failed:', err);
    }
  }

  private async refreshMarketMeta(): Promise<void> {
    try {
      const markets = await this.kalshiRest.getWeatherMarkets();
      for (const m of markets) {
        this.marketMeta.set(m.ticker, { title: m.title || m.subtitle || m.ticker, ticker: m.ticker });
      }
      console.log(`Market metadata refreshed: ${this.marketMeta.size} markets`);
    } catch (err) {
      console.warn('Market metadata refresh failed:', err);
    }
  }

  private onOrderbookUpdate(ticker: string): void {
    if (!ticker.startsWith('KXHIGH')) return;
    const forecasts = this.noaa.getLatestForecasts();
    if (forecasts.size === 0) return;
    this.runFullScan();
  }

  private runFullScan(): void {
    if (this.safety.isKilled()) return;
    if (this.bankroll <= 0) return;

    const forecasts = this.noaa.getLatestForecasts();
    const orderbook = this.feed.getOrderbook();

    const signals = this.detector.detectAll(orderbook, forecasts, this.bankroll, this.marketMeta);

    for (const signal of signals) {
      this.executor.execute(signal, this.bankroll).catch((err) => {
        console.error(`Trade execution failed for ${signal.ticker}:`, err);
      });
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  getStatus() {
    return {
      running: this.running,
      bankroll: this.bankroll,
      safety: this.safety.getStatus(),
      marketCount: this.feed.getMarketTickers().length,
      wsConnected: this.feed.isWebSocketConnected(),
      signals: this.detector.getCurrentSignals().length,
    };
  }

  getCurrentSignals() {
    return this.detector.getCurrentSignals();
  }

  getPositions() {
    return this.safety.getPositions();
  }

  getForecasts(): DailyForecast[] {
    return Array.from(this.noaa.getLatestForecasts().values());
  }

  killSwitch(): void {
    this.safety.kill();
    this.executor.cancelAll();
  }

  resetSafety(): void {
    this.safety.reset();
  }
}

let agentInstance: MarketAgent | null = null;

// ── Auth + Rate Limit Middleware ──

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function requireAuth(req: Request, res: Response, next: () => void): void {
  // Local-only gateway: allow if request is from loopback
  const ip = req.ip ?? req.socket.remoteAddress ?? '';
  const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';

  // If GH_PAT is configured, require it as Bearer token for non-local requests
  if (!isLocal && config.ghPat) {
    const auth = req.headers.authorization;
    if (!auth || auth !== `Bearer ${config.ghPat}`) {
      res.status(401).json({ status: 'error', message: 'Unauthorized' });
      return;
    }
  }

  // Rate limit mutation endpoints
  const key = `${ip}:${req.path}`;
  const now = Date.now();
  let entry = rateLimitMap.get(key);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateLimitMap.set(key, entry);
  }
  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) {
    res.status(429).json({ status: 'error', message: 'Rate limited' });
    return;
  }

  next();
}

export function createMarketAgentRouter(): Router {
  const router = Router();

  router.post('/start', requireAuth, async (req: Request, res: Response) => {
    if (!agentInstance) {
      agentInstance = new MarketAgent();
    }
    await agentInstance.start();
    res.json({ status: 'started' });
  });

  router.post('/stop', requireAuth, (req: Request, res: Response) => {
    if (agentInstance) {
      agentInstance.stop();
    }
    res.json({ status: 'stopped' });
  });

  router.get('/status', (req: Request, res: Response) => {
    if (!agentInstance) {
      res.json({ running: false });
      return;
    }
    res.json(agentInstance.getStatus());
  });

  router.get('/signals', (req: Request, res: Response) => {
    if (!agentInstance) {
      res.json({ signals: [] });
      return;
    }
    res.json({ signals: agentInstance.getCurrentSignals() });
  });

  router.get('/positions', (req: Request, res: Response) => {
    if (!agentInstance) {
      res.json({ positions: [] });
      return;
    }
    res.json({ positions: agentInstance.getPositions() });
  });

  router.get('/forecasts', (req: Request, res: Response) => {
    if (!agentInstance) {
      res.json({ forecasts: [] });
      return;
    }
    res.json({ forecasts: agentInstance.getForecasts() });
  });

  router.post('/kill', requireAuth, (req: Request, res: Response) => {
    if (!agentInstance) {
      res.status(400).json({ status: 'error', message: 'Agent not running' });
      return;
    }
    agentInstance.killSwitch();
    res.json({ status: 'killed' });
  });

  router.post('/reset', requireAuth, (req: Request, res: Response) => {
    if (!agentInstance) {
      res.status(400).json({ status: 'error', message: 'Agent not running' });
      return;
    }
    agentInstance.resetSafety();
    res.json({ status: 'reset' });
  });

  return router;
}