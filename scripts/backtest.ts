#!/usr/bin/env npx tsx
/**
 * Backtest engine — retroactively evaluates all historical mispricing signals
 * against actual observed temperatures from NWS to compute real win/loss rates.
 *
 * Usage: npx tsx scripts/backtest.ts
 */

import initSqlJs from 'sql.js';
import { resolve } from 'path';

const DB_PATH = resolve('D:/ai-knowledge/databases/market-agent.db');
const NWS_BASE = 'https://api.weather.gov';
const USER_AGENT = 'market-agent-backtest/1.0';

interface MispricingEvent {
  id: number;
  timestamp_ms: number;
  market_ticker: string;
  city: string;
  target_date: string;
  noaa_forecast_f: number;
  noaa_confidence: number;
  bucket_range: [number, number];
  market_price: number;
  edge: number;
  kelly_fraction: number;
  recommended_contracts: number;
}

interface BacktestResult {
  ticker: string;
  city: string;
  targetDate: string;
  forecastF: number;
  actualF: number | null;
  bucketLow: number;
  bucketHigh: number;
  marketPrice: number;
  edge: number;
  kellyFraction: number;
  contracts: number;
  outcome: 'win' | 'loss' | 'unsettled';
  pnl: number;
}

// NWS observation stations per city
const STATIONS: Record<string, string> = {
  NYC: 'KNYC',   // Central Park
  LA: 'KLAX',    // LAX airport
  Chicago: 'KORD', // O'Hare
  Miami: 'KMIA',  // MIA airport
  Dallas: 'KDFW', // DFW airport
};

// Cache observed temps to avoid re-fetching
const observedCache = new Map<string, number | null>();

async function fetchObservedHigh(station: string, date: string): Promise<number | null> {
  const key = `${station}-${date}`;
  if (observedCache.has(key)) return observedCache.get(key)!;

  try {
    // NWS observations endpoint: /stations/{stationId}/observations
    // Filter to the target date
    const start = `${date}T00:00:00Z`;
    const end = `${date}T23:59:59Z`;
    const url = `${NWS_BASE}/stations/${station}/observations?start=${start}&end=${end}`;

    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/geo+json' },
    });

    if (!res.ok) {
      console.warn(`NWS obs ${station} ${date}: ${res.status}`);
      observedCache.set(key, null);
      return null;
    }

    const data = await res.json() as any;
    const features = data.features || [];

    if (features.length === 0) {
      observedCache.set(key, null);
      return null;
    }

    // Extract max temperature from observations (comes in Celsius, convert to F)
    let maxTempF = -Infinity;
    for (const f of features) {
      const tempC = f.properties?.temperature?.value;
      if (tempC !== null && tempC !== undefined) {
        const tempF = tempC * 9 / 5 + 32;
        if (tempF > maxTempF) maxTempF = tempF;
      }
    }

    const result = maxTempF === -Infinity ? null : Math.round(maxTempF);
    observedCache.set(key, result);
    return result;
  } catch (err) {
    console.warn(`NWS obs fetch error ${station} ${date}:`, (err as Error).message);
    observedCache.set(key, null);
    return null;
  }
}

function didBucketHit(actualF: number, bucketLow: number, bucketHigh: number): boolean {
  // Bucket ranges: [low, high] where -999 = below, 999 = above
  if (bucketLow === -999) return actualF <= bucketHigh;  // "under X" bucket
  if (bucketHigh === 999) return actualF >= bucketLow;   // "over X" bucket
  return actualF >= bucketLow && actualF <= bucketHigh;   // exact range bucket
}

async function loadMispricingSignals(db: any): Promise<MispricingEvent[]> {
  const stmt = db.prepare(
    `SELECT id, timestamp_ms, market_ticker, payload
     FROM events
     WHERE event_type = 'mispricing_detected'
     ORDER BY timestamp_ms ASC`
  );

  const signals: MispricingEvent[] = [];
  const seen = new Set<string>(); // deduplicate by ticker+date

  while (stmt.step()) {
    const row = stmt.getAsObject() as any;
    try {
      const p = JSON.parse(row.payload);
      const key = `${p.ticker}-${p.target_date}`;
      if (seen.has(key)) continue; // take first signal per ticker-date
      seen.add(key);

      if ((p.recommended_contracts || 0) <= 0) continue; // skip non-tradeable

      signals.push({
        id: row.id,
        timestamp_ms: row.timestamp_ms,
        market_ticker: row.market_ticker,
        city: p.city,
        target_date: p.target_date,
        noaa_forecast_f: p.noaa_forecast_f,
        noaa_confidence: p.noaa_confidence,
        bucket_range: p.bucket_range,
        market_price: p.market_price,
        edge: p.edge,
        kelly_fraction: p.kelly_fraction,
        recommended_contracts: p.recommended_contracts,
      });
    } catch {}
  }
  stmt.free();
  return signals;
}

async function runBacktest(): Promise<void> {
  console.log('=== Market Agent Backtest Engine ===\n');

  // Load SQLite DB
  const SQL = await initSqlJs();
  const { readFileSync } = await import('fs');
  const dbBuffer = readFileSync(DB_PATH);
  const db = new SQL.Database(dbBuffer);

  // Load all tradeable mispricing signals
  const signals = await loadMispricingSignals(db);
  console.log(`Loaded ${signals.length} unique tradeable signals`);

  // Group by target date to identify settled vs future
  const today = new Date().toISOString().slice(0, 10);
  const settledSignals = signals.filter(s => s.target_date < today);
  const futureSignals = signals.filter(s => s.target_date >= today);
  console.log(`Settled dates: ${settledSignals.length} signals | Future: ${futureSignals.length}\n`);

  if (settledSignals.length === 0) {
    console.log('No settled signals to backtest. Need historical data with past target dates.');
    db.close();
    return;
  }

  // Fetch actual observed temps for each city-date pair
  const cityDates = new Map<string, Set<string>>();
  for (const s of settledSignals) {
    if (!cityDates.has(s.city)) cityDates.set(s.city, new Set());
    cityDates.get(s.city)!.add(s.target_date);
  }

  console.log('Fetching observed temperatures from NWS...');
  let fetchCount = 0;
  for (const [city, dates] of cityDates) {
    const station = STATIONS[city];
    if (!station) {
      console.warn(`No station mapping for city: ${city}`);
      continue;
    }
    for (const date of dates) {
      await fetchObservedHigh(station, date);
      fetchCount++;
      if (fetchCount % 10 === 0) process.stdout.write(`  ${fetchCount} dates fetched...\r`);
      // Rate limit: NWS asks for <5 req/sec
      await new Promise(r => setTimeout(r, 250));
    }
  }
  console.log(`\nFetched observed temps for ${fetchCount} city-date pairs\n`);

  // Evaluate each signal
  const results: BacktestResult[] = [];
  for (const s of settledSignals) {
    const station = STATIONS[s.city];
    if (!station) continue;

    const actualF = observedCache.get(`${station}-${s.target_date}`) ?? null;
    if (actualF === null) {
      results.push({
        ticker: s.market_ticker, city: s.city, targetDate: s.target_date,
        forecastF: s.noaa_forecast_f, actualF: null,
        bucketLow: s.bucket_range[0], bucketHigh: s.bucket_range[1],
        marketPrice: s.market_price, edge: s.edge,
        kellyFraction: s.kelly_fraction, contracts: s.recommended_contracts,
        outcome: 'unsettled', pnl: 0,
      });
      continue;
    }

    const hit = didBucketHit(actualF, s.bucket_range[0], s.bucket_range[1]);
    const outcome = hit ? 'win' : 'loss';
    // Win: payout is $1 per contract minus cost. Loss: lose the cost.
    const pnl = hit
      ? s.recommended_contracts * (1 - s.market_price)
      : -s.recommended_contracts * s.market_price;

    results.push({
      ticker: s.market_ticker, city: s.city, targetDate: s.target_date,
      forecastF: s.noaa_forecast_f, actualF,
      bucketLow: s.bucket_range[0], bucketHigh: s.bucket_range[1],
      marketPrice: s.market_price, edge: s.edge,
      kellyFraction: s.kelly_fraction, contracts: s.recommended_contracts,
      outcome, pnl,
    });
  }

  // ── Summary Statistics ──
  const settled = results.filter(r => r.outcome !== 'unsettled');
  const wins = settled.filter(r => r.outcome === 'win');
  const losses = settled.filter(r => r.outcome === 'loss');
  const totalPnL = settled.reduce((s, r) => s + r.pnl, 0);
  const totalCost = settled.reduce((s, r) => s + r.contracts * r.marketPrice, 0);

  console.log('════════════════════════════════════════════════');
  console.log('          BACKTEST RESULTS SUMMARY');
  console.log('════════════════════════════════════════════════');
  console.log(`Total signals evaluated:  ${results.length}`);
  console.log(`Settled (have actuals):   ${settled.length}`);
  console.log(`Unsettled (no NWS data):  ${results.filter(r => r.outcome === 'unsettled').length}`);
  console.log(`Wins: ${wins.length} | Losses: ${losses.length} | Win Rate: ${settled.length > 0 ? ((wins.length/settled.length)*100).toFixed(1) : 0}%`);
  console.log(`Total P&L: $${totalPnL.toFixed(2)}`);
  console.log(`Total Capital Deployed: $${totalCost.toFixed(2)}`);
  console.log(`ROI: ${totalCost > 0 ? ((totalPnL/totalCost)*100).toFixed(1) : 0}%`);
  console.log(`Avg Edge (predicted): $${(settled.reduce((s,r)=>s+r.edge,0)/Math.max(1,settled.length)).toFixed(3)}`);

  // ── Per-City Breakdown ──
  console.log('\n── Per-City Performance ──');
  console.log('City     | Trades | Wins | Losses | Win%  | P&L      | Cost     | ROI');
  console.log('---------|--------|------|--------|-------|----------|----------|--------');

  const cities = [...new Set(settled.map(r => r.city))].sort();
  const cityStats: Record<string, any> = {};

  for (const city of cities) {
    const ct = settled.filter(r => r.city === city);
    const cw = ct.filter(r => r.outcome === 'win');
    const cpnl = ct.reduce((s, r) => s + r.pnl, 0);
    const ccost = ct.reduce((s, r) => s + r.contracts * r.marketPrice, 0);
    const wr = ct.length > 0 ? (cw.length / ct.length * 100).toFixed(1) : '0.0';
    const roi = ccost > 0 ? (cpnl / ccost * 100).toFixed(1) : '0.0';

    cityStats[city] = { trades: ct.length, wins: cw.length, losses: ct.length - cw.length, winRate: wr, pnl: cpnl, cost: ccost, roi };

    console.log(
      `${city.padEnd(8)} | ${String(ct.length).padStart(6)} | ${String(cw.length).padStart(4)} | ${String(ct.length - cw.length).padStart(6)} | ${wr.padStart(4)}% | $${cpnl.toFixed(2).padStart(7)} | $${ccost.toFixed(2).padStart(7)} | ${roi}%`
    );
  }

  // ── Forecast Accuracy ──
  console.log('\n── Forecast Accuracy (NOAA vs Actual) ──');
  console.log('City     | Samples | Avg Error | Median Error | Max Error');
  console.log('---------|---------|-----------|--------------|----------');

  for (const city of cities) {
    const ct = settled.filter(r => r.city === city && r.actualF !== null);
    if (ct.length === 0) continue;
    const errors = ct.map(r => Math.abs(r.forecastF - r.actualF!));
    const avg = errors.reduce((a, b) => a + b, 0) / errors.length;
    const sorted = [...errors].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const max = sorted[sorted.length - 1];
    console.log(
      `${city.padEnd(8)} | ${String(ct.length).padStart(7)} | ${avg.toFixed(1).padStart(7)}°F | ${String(median).padStart(10)}°F | ${String(max).padStart(7)}°F`
    );
  }

  // ── Edge Bucket Analysis ──
  console.log('\n── Edge Bucket Analysis (does bigger edge = better win rate?) ──');
  const edgeBuckets = [
    { label: '$0.00-0.10', min: 0, max: 0.10 },
    { label: '$0.10-0.20', min: 0.10, max: 0.20 },
    { label: '$0.20-0.50', min: 0.20, max: 0.50 },
    { label: '$0.50+', min: 0.50, max: Infinity },
  ];
  console.log('Edge Range  | Trades | Wins | Win%  | Avg P&L/Trade');
  console.log('------------|--------|------|-------|-------------');
  for (const bucket of edgeBuckets) {
    const bt = settled.filter(r => r.edge >= bucket.min && r.edge < bucket.max);
    if (bt.length === 0) continue;
    const bw = bt.filter(r => r.outcome === 'win');
    const bpnl = bt.reduce((s, r) => s + r.pnl, 0);
    console.log(
      `${bucket.label.padEnd(11)} | ${String(bt.length).padStart(6)} | ${String(bw.length).padStart(4)} | ${bt.length > 0 ? ((bw.length/bt.length)*100).toFixed(1).padStart(4) : '  0'}% | $${(bpnl/bt.length).toFixed(3)}`
    );
  }

  // ── Top 10 Best and Worst Trades ──
  console.log('\n── Top 10 Best Trades ──');
  const byPnl = [...settled].sort((a, b) => b.pnl - a.pnl);
  for (const t of byPnl.slice(0, 10)) {
    console.log(`  ${t.ticker} | ${t.city} ${t.targetDate} | forecast=${t.forecastF}°F actual=${t.actualF}°F | bucket=[${t.bucketLow},${t.bucketHigh}] | price=$${t.marketPrice.toFixed(2)} | P&L=$${t.pnl.toFixed(2)}`);
  }

  console.log('\n── Top 10 Worst Trades ──');
  for (const t of byPnl.slice(-10).reverse()) {
    console.log(`  ${t.ticker} | ${t.city} ${t.targetDate} | forecast=${t.forecastF}°F actual=${t.actualF}°F | bucket=[${t.bucketLow},${t.bucketHigh}] | price=$${t.marketPrice.toFixed(2)} | P&L=$${t.pnl.toFixed(2)}`);
  }

  console.log('\n════════════════════════════════════════════════');
  console.log('Backtest complete.');

  db.close();
}

runBacktest().catch(err => {
  console.error('Backtest failed:', err);
  process.exit(1);
});
