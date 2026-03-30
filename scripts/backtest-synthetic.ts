#!/usr/bin/env npx tsx
/**
 * Synthetic backtest — uses Open-Meteo historical observation archives
 * to evaluate forecast accuracy per city over the last 30 days.
 * Simulates forecast error + Kalshi bucket pricing to estimate ROI.
 *
 * Usage: npx tsx scripts/backtest-synthetic.ts
 */

const CITIES = [
  { name: 'NYC', lat: 40.78, lon: -73.97, tz: 'America/New_York' },
  { name: 'LA', lat: 34.05, lon: -118.24, tz: 'America/Los_Angeles' },
  { name: 'Chicago', lat: 41.88, lon: -87.63, tz: 'America/Chicago' },
  { name: 'Miami', lat: 25.76, lon: -80.19, tz: 'America/New_York' },
  { name: 'Dallas', lat: 32.78, lon: -96.80, tz: 'America/Chicago' },
  { name: 'Denver', lat: 39.74, lon: -104.99, tz: 'America/Denver' },
  { name: 'Austin', lat: 30.27, lon: -97.74, tz: 'America/Chicago' },
];

interface SimTrade {
  city: string; date: string; forecastF: number; actualF: number;
  bucketLow: number; bucketHigh: number; simPrice: number;
  modelProb: number; edge: number; outcome: 'win' | 'loss'; pnl: number;
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

async function fetchHistoricalHighs(lat: number, lon: number, tz: string, startDate: string, endDate: string): Promise<Array<{date: string; highF: number}>> {
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${startDate}&end_date=${endDate}&daily=temperature_2m_max&temperature_unit=fahrenheit&timezone=${encodeURIComponent(tz)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}: ${await res.text()}`);
  const data = await res.json() as any;
  const times: string[] = data.daily.time;
  const temps: number[] = data.daily.temperature_2m_max;
  return times.map((t, i) => ({ date: t, highF: Math.round(temps[i]) }));
}

function normalCDF(x: number): number {
  const a1=0.254829592, a2=-0.284496736, a3=1.421413741;
  const a4=-1.453152027, a5=1.061405429, p=0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-x*x);
  return 0.5 * (1.0 + sign * y);
}

// Simulate NOAA forecast: actual + gaussian noise (σ configurable per scenario)
function simulateForecast(actualF: number, sigma: number): number {
  const u1 = Math.random(), u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.round(actualF + z * sigma);
}

/**
 * Generate Kalshi-like buckets centered on forecast.
 * 6 brackets: 2 edge + 4 middle (2°F wide). Prices simulate typical market.
 */
function generateBuckets(forecastF: number): Array<{low:number; high:number; simPrice:number; prob:number}> {
  const c = Math.round(forecastF);
  const buckets = [
    { low: -999, high: c - 3, simPrice: 0.04, prob: 0 },
    { low: c - 2, high: c - 1, simPrice: 0.12, prob: 0 },
    { low: c,     high: c + 1, simPrice: 0.30, prob: 0 },
    { low: c + 2, high: c + 3, simPrice: 0.25, prob: 0 },
    { low: c + 4, high: c + 5, simPrice: 0.10, prob: 0 },
    { low: c + 6, high: 999,   simPrice: 0.04, prob: 0 },
  ];
  // Assign model probabilities (normal dist with σ=2 around forecast)
  for (const b of buckets) {
    const lo = b.low === -999 ? -100 : b.low;
    const hi = b.high === 999 ? 200 : b.high;
    b.prob = normalCDF((hi + 1 - forecastF) / 2) - normalCDF((lo - forecastF) / 2);
  }
  return buckets;
}

function didBucketHit(actualF: number, low: number, high: number): boolean {
  if (low === -999) return actualF <= high;
  if (high === 999) return actualF >= low;
  return actualF >= low && actualF <= high;
}

async function runBacktest(): Promise<void> {
  console.log('=== Synthetic Backtest Engine (Open-Meteo) ===\n');

  // Run Monte Carlo: repeat the entire backtest N times to smooth out random forecast noise
  const MC_RUNS = 50;
  const FORECAST_SIGMA = 2.5; // realistic NOAA 24hr error
  const EDGE_THRESHOLD = 0.03;

  const endDate = new Date();
  endDate.setDate(endDate.getDate() - 1);
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - 59); // 60 days
  const startStr = startDate.toISOString().slice(0, 10);
  const endStr = endDate.toISOString().slice(0, 10);
  console.log(`Date range: ${startStr} to ${endStr}`);
  console.log(`Monte Carlo runs: ${MC_RUNS} | Forecast σ: ±${FORECAST_SIGMA}°F | Edge threshold: $${EDGE_THRESHOLD}\n`);

  // Fetch actual observed highs for all cities
  const cityData: Record<string, Array<{date:string; highF:number}>> = {};
  for (const city of CITIES) {
    console.log(`Fetching 60-day history for ${city.name}...`);
    cityData[city.name] = await fetchHistoricalHighs(city.lat, city.lon, city.tz, startStr, endStr);
    console.log(`  ${cityData[city.name].length} days`);
    await sleep(500); // rate limit
  }

  // Aggregate stats across MC runs
  const cityAgg: Record<string, {trades:number; wins:number; pnl:number; cost:number; errSum:number; errCount:number}> = {};
  for (const city of CITIES) cityAgg[city.name] = {trades:0, wins:0, pnl:0, cost:0, errSum:0, errCount:0};

  for (let run = 0; run < MC_RUNS; run++) {
    for (const city of CITIES) {
      const obs = cityData[city.name];
      for (const day of obs) {
        const forecastF = simulateForecast(day.highF, FORECAST_SIGMA);
        const buckets = generateBuckets(forecastF);

        // Find best edge bucket
        let bestBucket = buckets[0];
        let bestEdge = -Infinity;
        for (const b of buckets) {
          const edge = b.prob - b.simPrice;
          if (edge > bestEdge && edge > EDGE_THRESHOLD) { bestEdge = edge; bestBucket = b; }
        }
        if (bestEdge <= EDGE_THRESHOLD) continue;

        const hit = didBucketHit(day.highF, bestBucket.low, bestBucket.high);
        const pnl = hit ? (1 - bestBucket.simPrice) : -bestBucket.simPrice;

        const agg = cityAgg[city.name];
        agg.trades++;
        if (hit) agg.wins++;
        agg.pnl += pnl;
        agg.cost += bestBucket.simPrice;
        agg.errSum += Math.abs(forecastF - day.highF);
        agg.errCount++;
      }
    }
  }

  // ── Results ──
  console.log('\n════════════════════════════════════════════════════════════════');
  console.log('   SYNTHETIC BACKTEST RESULTS (Monte Carlo averaged)');
  console.log('════════════════════════════════════════════════════════════════');

  let totalTrades = 0, totalWins = 0, totalPnL = 0, totalCost = 0;
  for (const c of Object.values(cityAgg)) {
    totalTrades += c.trades; totalWins += c.wins; totalPnL += c.pnl; totalCost += c.cost;
  }

  console.log(`Total simulated trades: ${totalTrades} (${MC_RUNS} runs × ~${Math.round(totalTrades/MC_RUNS)} trades/run)`);
  console.log(`Win Rate: ${(totalWins/totalTrades*100).toFixed(1)}%`);
  console.log(`Total P&L: $${totalPnL.toFixed(2)} | Capital Deployed: $${totalCost.toFixed(2)}`);
  console.log(`Overall ROI: ${(totalPnL/totalCost*100).toFixed(1)}%\n`);

  // ── Per-City Breakdown ──
  console.log('── Per-City Performance (averaged over MC runs) ──');
  console.log('City     | Trades/Run | Wins | Win%  | P&L/Trade | ROI     | Avg Err | Currently Trading?');
  console.log('---------|------------|------|-------|-----------|---------|---------|-------------------');

  const currentCities = new Set(['NYC', 'LA', 'Chicago', 'Miami', 'Dallas']);
  const ranked: Array<{city:string; roi:number; winRate:number; trades:number; err:number; current:boolean}> = [];

  for (const city of CITIES) {
    const a = cityAgg[city.name];
    const tradesPerRun = a.trades / MC_RUNS;
    const wr = a.trades > 0 ? (a.wins / a.trades * 100) : 0;
    const roi = a.cost > 0 ? (a.pnl / a.cost * 100) : 0;
    const avgErr = a.errCount > 0 ? a.errSum / a.errCount : 0;
    const pnlPerTrade = a.trades > 0 ? a.pnl / a.trades : 0;
    const isCurrent = currentCities.has(city.name);

    ranked.push({city: city.name, roi, winRate: wr, trades: a.trades, err: avgErr, current: isCurrent});

    console.log(
      `${city.name.padEnd(8)} | ${tradesPerRun.toFixed(0).padStart(10)} | ${String(Math.round(a.wins/MC_RUNS)).padStart(4)} | ${wr.toFixed(1).padStart(4)}% | $${pnlPerTrade.toFixed(3).padStart(6)} | ${roi.toFixed(1).padStart(5)}% | ±${avgErr.toFixed(1)}°F  | ${isCurrent ? 'YES' : 'no'}`
    );
  }

  // ── Ranking ──
  ranked.sort((a, b) => b.roi - a.roi);
  console.log('\n── City Ranking by ROI ──');
  for (let i = 0; i < ranked.length; i++) {
    const r = ranked[i];
    const tag = r.current ? '' : ' [NOT TRADING]';
    const indicator = r.roi > 0 ? '✓' : '✗';
    console.log(`  ${i+1}. ${indicator} ${r.city}: ${r.roi.toFixed(1)}% ROI | ${r.winRate.toFixed(1)}% win rate | ±${r.err.toFixed(1)}°F avg error${tag}`);
  }

  // ── Recommendations ──
  console.log('\n── Recommendations ──');
  const profitable = ranked.filter(r => r.roi > 10);
  const unprofitable = ranked.filter(r => r.roi < -10 && r.current);
  const missingOpps = ranked.filter(r => r.roi > 10 && !r.current);

  if (unprofitable.length > 0) {
    console.log(`DROP: ${unprofitable.map(r => r.city).join(', ')} — negative ROI, dragging portfolio down`);
  }
  if (missingOpps.length > 0) {
    console.log(`ADD:  ${missingOpps.map(r => `${r.city} (${r.roi.toFixed(0)}% ROI)`).join(', ')} — profitable cities we're not trading`);
  }
  if (profitable.length > 0) {
    console.log(`KEEP: ${profitable.filter(r => r.current).map(r => r.city).join(', ')} — positive ROI cities already in rotation`);
  }

  console.log('\n════════════════════════════════════════════════════════════════');
  console.log('NOTE: Forecast noise is simulated (σ=2.5°F). Real NOAA 24hr');
  console.log('forecasts are often better. Bucket prices are estimated from');
  console.log('typical Kalshi patterns. Results are directional, not exact.');
  console.log('════════════════════════════════════════════════════════════════');
}

runBacktest().catch(err => { console.error('Backtest failed:', err); process.exit(1); });
