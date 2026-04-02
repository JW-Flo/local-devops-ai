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
import { DailyForecast, MispricingSignal } from './types.js';
import { SettlementService } from './settlement.js';

// CITIES now imported from types.ts — single source of truth
// Remove this local duplicate

export class MarketAgent {
  private noaa: NOAAClient;
  private kalshiRest: KalshiRest;
  private feed: KalshiFeed;
  private detector: MispricingDetector;
  private safety: SafetyGuard;
  private executor: OrderExecutor;
  private settlement: SettlementService | null = null;
  private noaaTimer: NodeJS.Timeout | null = null;
  private bankroll = 0;
  private marketMeta: Map<string, { title: string; ticker: string }> = new Map();
  private running = false;
  private authenticated = false;
  private lastError: string | null = null;
  private errors: string[] = [];
  private lastScanTime = 0;
  private warmedUp = false;
  private readonly SCAN_COOLDOWN_MS = 30_000; // throttle orderbook-triggered scans

  constructor(paperMode = true) {
    this.noaa = new NOAAClient();
    this.kalshiRest = new KalshiRest();
    this.feed = new KalshiFeed(this.kalshiRest);
    this.detector = new MispricingDetector();
    this.safety = new SafetyGuard();
    this.executor = new OrderExecutor(this.kalshiRest, this.safety, paperMode);
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
    await this.executor.init();

    await withDb(async (db: Database) => {
      db.run(
        `INSERT INTO events (event_type, timestamp_ms, payload) VALUES (?, ?, ?)`,
        ['bot_started', Date.now(), JSON.stringify({ env: 'gateway' })]
      );
    }, { db: 'market-agent', persist: true });

    try {
      this.bankroll = await this.kalshiRest.getBalance();
      this.authenticated = true;
      this.lastError = null;
      console.log(`Initial balance: $${this.bankroll.toFixed(2)}`);

      // Sync existing positions so safety guard and dedup survive restarts
      await this.syncPositionsFromKalshi();

      // Start settlement service to resolve completed trades
      this.settlement = new SettlementService(this.kalshiRest, this.executor.getPerformance(), this.safety);
      this.settlement.start();
    } catch (err) {
      const msg = (err as Error).message;
      this.authenticated = false;
      this.lastError = `Kalshi auth failed: ${msg}`;
      this.errors.push(this.lastError);
      console.error(`[market-agent] ${this.lastError}`);
      // Still start NOAA pipeline so forecasts flow, but skip Kalshi feed
      console.warn('[market-agent] Running in NOAA-only mode (no Kalshi connection)');
      await this.pollNOAA();
      this.noaaTimer = setInterval(() => this.pollNOAA(), 30 * 60 * 1000);
      return; // Don't start WS feed or market refresh without auth
    }

    await this.feed.start();

    this.feed.on('orderbook_update', (ticker: string) => {
      this.onOrderbookUpdate(ticker);
    });

    // Refresh market meta FIRST so runFullScan has tickers to work with
    await this.refreshMarketMeta();
    setInterval(() => this.refreshMarketMeta(), 15 * 60 * 1000);

    await this.pollNOAA();
    this.noaaTimer = setInterval(() => this.pollNOAA(), 30 * 60 * 1000);

    // Allow 30s for WS ticker data to warm the cache before first scan
    setTimeout(() => {
      this.warmedUp = true;
      const tickerCount = this.feed.getTickerSnapshot().size;
      console.log(`[market-agent] Ticker warmup complete (${tickerCount} prices cached), running initial scan`);
      this.runFullScan();
    }, 30_000);

    await notify(`Bot started | Bankroll: $${this.bankroll.toFixed(2)}`);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;

    console.log('Stopping Market Agent');
    if (this.noaaTimer) clearInterval(this.noaaTimer);
    if (this.settlement) this.settlement.stop();
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
      if (this.warmedUp) this.runFullScan();
    } catch (err) {
      console.error('NOAA poll failed:', err);
    }
  }

  private async syncPositionsFromKalshi(): Promise<void> {
    try {
      const positions = await this.kalshiRest.getPositions();
      let synced = 0;
      for (const pos of positions) {
        if (pos.position > 0 && pos.ticker.startsWith('KXHIGH')) {
          // Reconstruct approximate avg price from exposure
          const avgPrice = pos.market_exposure > 0
            ? pos.market_exposure / pos.position / 100
            : 0.10; // fallback estimate
          this.safety.recordTrade(pos.ticker, pos.position, avgPrice);
          this.executor.markAsExecuted(pos.ticker);
          synced++;
        }
      }
      if (synced > 0) {
        console.log(`[market-agent] Synced ${synced} existing positions from Kalshi`);
      }
    } catch (err) {
      console.warn('[market-agent] Position sync failed:', (err as Error).message);
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
    if (!this.warmedUp) return;
    if (!ticker.startsWith('KXHIGH')) return;
    const forecasts = this.noaa.getLatestForecasts();
    if (forecasts.size === 0) return;
    // Throttle: orderbook deltas can arrive hundreds/sec — cap to once per 30s
    const now = Date.now();
    if (now - this.lastScanTime < this.SCAN_COOLDOWN_MS) return;
    this.runFullScan();
  }

  private runFullScan(): void {
    if (this.safety.isKilled()) return;
    if (this.bankroll <= 0) return;
    if (this.marketMeta.size === 0) return; // no markets yet — don't poison cooldown

    const forecasts = this.noaa.getLatestForecasts();
    const orderbook = this.feed.getOrderbook();
    const tickerCache = this.feed.getTickerSnapshot();

    // Don't poison the cooldown if we have no price data yet (WS still warming up)
    if (tickerCache.size === 0) return;
    this.lastScanTime = Date.now();

    const signals = this.detector.detectAll(orderbook, forecasts, this.bankroll, this.marketMeta, tickerCache);

    // Execute sequentially — prevents race conditions where multiple signals
    // pass safety checks before any trade is recorded
    this.executeSignalsSequentially(signals, tickerCache).catch((err) => {
      console.error('[market-agent] Sequential execution error:', err);
    });
  }

  private async executeSignalsSequentially(signals: MispricingSignal[], tickerCache?: Map<string, any>): Promise<void> {
    const tradeable = signals.filter(s => s.recommendedContracts > 0);
    if (tradeable.length === 0) return;

    for (const signal of tradeable) {
      try {
        const traded = await this.executor.execute(signal, this.bankroll, tickerCache);
        if (traded) {
          // Refresh bankroll from Kalshi after each successful trade
          try {
            this.bankroll = await this.kalshiRest.getBalance();
          } catch (err) {
            console.warn('[market-agent] Balance refresh failed, using estimate');
            this.bankroll -= signal.recommendedContracts * signal.marketPrice;
          }
        }
      } catch (err) {
        console.error(`Trade execution failed for ${signal.ticker}:`, err);
      }
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  getStatus() {
    const signals = this.detector.getCurrentSignals();
    const yesBuySignals = signals.filter(s => s.side === 'yes');
    const noBuySignals = signals.filter(s => s.side === 'no');
    return {
      running: this.running,
      authenticated: this.authenticated,
      paperMode: this.executor.paperMode,
      bankroll: this.bankroll,
      safety: this.safety.getStatus(),
      marketCount: this.authenticated ? this.feed.getMarketTickers().length : 0,
      wsConnected: this.authenticated ? this.feed.isWebSocketConnected() : false,
      signals: signals.length,
      signalBreakdown: { yesBuy: yesBuySignals.length, noBuy: noBuySignals.length },
      kellyFraction: this.detector.getKellyFraction(),
      edgeThreshold: this.detector.getEdgeThreshold(),
      lastError: this.lastError,
      errors: this.errors.slice(-10),
      performance: this.executor.getPerformance().getStats(),
    };
  }

  setPaperMode(enabled: boolean): void {
    this.executor.paperMode = enabled;
  }

  getPerformanceStats() {
    return this.executor.getPerformance().getStats();
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

  setKellyFraction(f: number): void {
    this.detector.setKellyFraction(f);
  }

  getKellyFraction(): number {
    return this.detector.getKellyFraction();
  }

  setEdgeThreshold(t: number): void {
    this.detector.setEdgeThreshold(t);
  }

  getEdgeThreshold(): number {
    return this.detector.getEdgeThreshold();
  }

  async runSettlement() {
    if (!this.settlement) throw new Error('Settlement service not initialized');
    return this.settlement.runNow();
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

  router.get('/events', async (req: Request, res: Response) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 100, 500);
      const type = req.query.type as string | undefined;

      const rows = await withDb(async (db: Database) => {
        const where = type ? 'WHERE event_type = ?' : '';
        const params = type ? [type, limit] : [limit];
        const stmt = db.prepare(
          `SELECT id, event_type, timestamp_ms, market_ticker, payload, created_at
           FROM events ${where}
           ORDER BY timestamp_ms DESC LIMIT ?`
        );
        stmt.bind(params);
        const results: any[] = [];
        while (stmt.step()) {
          const row = stmt.getAsObject();
          results.push({
            ...row,
            payload: row.payload ? JSON.parse(row.payload as string) : null,
          });
        }
        stmt.free();
        return results;
      }, { db: 'market-agent' });

      // Also fetch summary counts
      const summary = await withDb(async (db: Database) => {
        const stmt = db.prepare(
          `SELECT event_type, COUNT(*) as count FROM events GROUP BY event_type ORDER BY count DESC`
        );
        const results: Record<string, number> = {};
        while (stmt.step()) {
          const row = stmt.getAsObject();
          results[row.event_type as string] = row.count as number;
        }
        stmt.free();
        return results;
      }, { db: 'market-agent' });

      res.json({ events: rows, summary, total: rows.length });
    } catch (err) {
      res.status(500).json({ status: 'error', message: (err as Error).message });
    }
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

  router.post('/paper', requireAuth, (req: Request, res: Response) => {
    if (!agentInstance) {
      res.status(400).json({ status: 'error', message: 'Agent not running' });
      return;
    }
    const enabled = req.body?.enabled !== false; // default true
    agentInstance.setPaperMode(enabled);
    res.json({ status: 'ok', paperMode: enabled });
  });

  router.post('/kelly', requireAuth, (req: Request, res: Response) => {
    if (!agentInstance) {
      res.status(400).json({ status: 'error', message: 'Agent not running' });
      return;
    }
    const fraction = Number(req.body?.fraction);
    if (!fraction || fraction < 0.05 || fraction > 1.0) {
      res.status(400).json({ status: 'error', message: 'fraction must be 0.05-1.0 (0.25=quarter, 0.50=half)' });
      return;
    }
    agentInstance.setKellyFraction(fraction);
    res.json({ status: 'ok', kellyFraction: fraction });
  });

  router.post('/edge-threshold', requireAuth, (req: Request, res: Response) => {
    if (!agentInstance) {
      res.status(400).json({ status: 'error', message: 'Agent not running' });
      return;
    }
    const threshold = Number(req.body?.threshold);
    if (!threshold || threshold < 0.01 || threshold > 0.20) {
      res.status(400).json({ status: 'error', message: 'threshold must be 0.01-0.20' });
      return;
    }
    agentInstance.setEdgeThreshold(threshold);
    res.json({ status: 'ok', edgeThreshold: threshold });
  });

  router.post('/live', requireAuth, (req: Request, res: Response) => {
    if (!agentInstance) {
      res.status(400).json({ status: 'error', message: 'Agent not running' });
      return;
    }
    agentInstance.setPaperMode(false);
    res.json({ status: 'ok', paperMode: false, warning: 'LIVE TRADING ENABLED — real money at risk' });
  });

  router.get('/performance', (req: Request, res: Response) => {
    if (!agentInstance) {
      res.json({ trades: 0, message: 'Agent not running' });
      return;
    }
    res.json(agentInstance.getPerformanceStats());
  });

  router.post('/settlement/run', requireAuth, async (req: Request, res: Response) => {
    if (!agentInstance) {
      res.status(400).json({ status: 'error', message: 'Agent not running' });
      return;
    }
    try {
      const results = await agentInstance.runSettlement();
      res.json({ status: 'ok', settled: results.length, results });
    } catch (err) {
      res.status(500).json({ status: 'error', message: (err as Error).message });
    }
  });

  return router;
}