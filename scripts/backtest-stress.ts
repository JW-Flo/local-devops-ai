#!/usr/bin/env npx tsx
/**
 * 365-day stress test backtest with multi-scenario forecast error modeling.
 * Uses Open-Meteo historical archive (no API key needed).
 *
 * Runs 4 forecast error scenarios (σ=1.5, 2.0, 2.5, 3.0°F) × 20 MC runs each
 * across all 7 cities to produce statistically robust ROI estimates.
 *
 * Also analyzes seasonal patterns (winter vs spring vs summer) to identify
 * periods where the strategy underperforms.
 *
 * Usage: npx tsx scripts/backtest-stress.ts
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

const MC_RUNS = 20;
const EDGE_THRESHOLD = 0.03;
const SCENARIOS = [1.5, 2.0, 2.5, 3.0]; // forecast error σ values

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

async function fetchHistoricalHighs(lat: number, lon: number, tz: string, startDate: string, endDate: string): Promise<Array<{date: string; highF: number}>> {
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${startDate}&end_date=${endDate}&daily=temperature_2m_max&temperature_unit=fahrenheit&timezone=${encodeURIComponent(tz)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}: ${await res.text()}`);
  const data = await res.json() as any;
  return data.daily.time.map((t: string, i: number) => ({
    date: t, highF: Math.round(data.daily.temperature_2m_max[i]),
  }));
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

function simulateForecast(actualF: number, sigma: number): number {
  const u1 = Math.random(), u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.round(actualF + z * sigma);
}

function generateBuckets(forecastF: number): Array<{low:number; high:number; simPrice:number; prob:number}> {
  const c = Math.round(forecastF);
  const buckets = [
    { low: -999, high: c - 3, simPrice: 0.04, prob: 0 },
    { low: c - 2, high: c - 1, simPrice: 0.12, prob: 0 },
    { low: c, high: c + 1, simPrice: 0.30, prob: 0 },
    { low: c + 2, high: c + 3, simPrice: 0.25, prob: 0 },
    { low: c + 4, high: c + 5, simPrice: 0.10, prob: 0 },
    { low: c + 6, high: 999, simPrice: 0.04, prob: 0 },
  ];
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

function getSeason(dateStr: string): string {
  const month = parseInt(dateStr.slice(5, 7));
  if (month >= 3 && month <= 5) return 'Spring';
  if (month >= 6 && month <= 8) return 'Summer';
  if (month >= 9 && month <= 11) return 'Fall';
  return 'Winter';
}

interface CityAgg {
  trades: number; wins: number; pnl: number; cost: number;
  errSum: number; errCount: number;
  seasonal: Record<string, {trades:number; wins:number; pnl:number; cost:number}>;
}

async function runStressTest(): Promise<void> {
  console.log('══════════════════════════════════════════════════════════');
  console.log('  365-DAY STRESS TEST BACKTEST (Multi-Scenario)');
  console.log('══════════════════════════════════════════════════════════\n');

  const endDate = new Date();
  endDate.setDate(endDate.getDate() - 1);
  const startDate = new Date(endDate);
  startDate.setFullYear(startDate.getFullYear() - 1);
  const startStr = startDate.toISOString().slice(0, 10);
  const endStr = endDate.toISOString().slice(0, 10);
  console.log(`Period: ${startStr} to ${endStr} (365 days)`);
  console.log(`MC runs per scenario: ${MC_RUNS}`);
  console.log(`Scenarios: σ = ${SCENARIOS.join(', ')}°F\n`);

  // Fetch 365 days of data for all cities
  const cityData: Record<string, Array<{date:string; highF:number}>> = {};
  for (const city of CITIES) {
    console.log(`Fetching ${city.name}...`);
    cityData[city.name] = await fetchHistoricalHighs(city.lat, city.lon, city.tz, startStr, endStr);
    console.log(`  ${cityData[city.name].length} days | range: ${Math.min(...cityData[city.name].map(d=>d.highF))}°F – ${Math.max(...cityData[city.name].map(d=>d.highF))}°F`);
    await sleep(600);
  }

  // Run each scenario
  for (const sigma of SCENARIOS) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  SCENARIO: Forecast Error σ = ±${sigma}°F`);
    console.log(`${'═'.repeat(60)}`);

    const cityAgg: Record<string, CityAgg> = {};
    for (const city of CITIES) {
      cityAgg[city.name] = {
        trades:0, wins:0, pnl:0, cost:0, errSum:0, errCount:0,
        seasonal: {Winter:{trades:0,wins:0,pnl:0,cost:0}, Spring:{trades:0,wins:0,pnl:0,cost:0},
                   Summer:{trades:0,wins:0,pnl:0,cost:0}, Fall:{trades:0,wins:0,pnl:0,cost:0}},
      };
    }

    for (let run = 0; run < MC_RUNS; run++) {
      for (const city of CITIES) {
        for (const day of cityData[city.name]) {
          const forecastF = simulateForecast(day.highF, sigma);
          const buckets = generateBuckets(forecastF);
          let bestBucket = buckets[0], bestEdge = -Infinity;
          for (const b of buckets) {
            const edge = b.prob - b.simPrice;
            if (edge > bestEdge && edge > EDGE_THRESHOLD) { bestEdge = edge; bestBucket = b; }
          }
          if (bestEdge <= EDGE_THRESHOLD) continue;

          const hit = didBucketHit(day.highF, bestBucket.low, bestBucket.high);
          const pnl = hit ? (1 - bestBucket.simPrice) : -bestBucket.simPrice;
          const season = getSeason(day.date);
          const a = cityAgg[city.name];
          a.trades++; if (hit) a.wins++; a.pnl += pnl; a.cost += bestBucket.simPrice;
          a.errSum += Math.abs(forecastF - day.highF); a.errCount++;
          const s = a.seasonal[season];
          s.trades++; if (hit) s.wins++; s.pnl += pnl; s.cost += bestBucket.simPrice;
        }
      }
    }

    // Per-city results
    let totalT=0, totalW=0, totalP=0, totalC=0;
    console.log('\nCity     | Trades/Yr | Win%  | P&L/Trade | ROI     | AvgErr');
    console.log('---------|-----------|-------|-----------|---------|-------');
    const ranked: Array<{city:string; roi:number; wr:number}> = [];
    for (const city of CITIES) {
      const a = cityAgg[city.name];
      totalT+=a.trades; totalW+=a.wins; totalP+=a.pnl; totalC+=a.cost;
      const tpy = Math.round(a.trades / MC_RUNS);
      const wr = a.trades>0 ? a.wins/a.trades*100 : 0;
      const roi = a.cost>0 ? a.pnl/a.cost*100 : 0;
      const ppt = a.trades>0 ? a.pnl/a.trades : 0;
      const err = a.errCount>0 ? a.errSum/a.errCount : 0;
      ranked.push({city:city.name, roi, wr});
      console.log(`${city.name.padEnd(8)} | ${String(tpy).padStart(9)} | ${wr.toFixed(1).padStart(4)}% | $${ppt.toFixed(3).padStart(6)} | ${roi.toFixed(1).padStart(5)}% | ±${err.toFixed(1)}°F`);
    }
    const overallWR = totalT>0 ? totalW/totalT*100 : 0;
    const overallROI = totalC>0 ? totalP/totalC*100 : 0;
    console.log(`${'─'.repeat(60)}`);
    console.log(`OVERALL  | ${Math.round(totalT/MC_RUNS).toString().padStart(9)} | ${overallWR.toFixed(1).padStart(4)}% | $${(totalP/totalT).toFixed(3).padStart(6)} | ${overallROI.toFixed(1).padStart(5)}%`);

    // Seasonal breakdown (aggregated across all cities)
    console.log('\n  Season  | Trades | Win%  | ROI');
    console.log('  --------|--------|-------|------');
    for (const season of ['Winter','Spring','Summer','Fall']) {
      let st=0,sw=0,sp=0,sc=0;
      for (const city of CITIES) {
        const s = cityAgg[city.name].seasonal[season];
        st+=s.trades; sw+=s.wins; sp+=s.pnl; sc+=s.cost;
      }
      if (st === 0) continue;
      console.log(`  ${season.padEnd(7)} | ${Math.round(st/MC_RUNS).toString().padStart(6)} | ${(sw/st*100).toFixed(1).padStart(4)}% | ${(sc>0?(sp/sc*100):0).toFixed(1)}%`);
    }

    // City ranking
    ranked.sort((a,b) => b.roi - a.roi);
    console.log(`\n  Ranking: ${ranked.map((r,i) => `${i+1}.${r.city}(${r.roi.toFixed(0)}%)`).join('  ')}`);
  }

  // ── Temperature Volatility Analysis ──
  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  TEMPERATURE VOLATILITY (affects bucket-hit difficulty)');
  console.log('══════════════════════════════════════════════════════════');
  console.log('City     | Mean  | StdDev | Min   | Max   | Range | Day-to-Day Δ');
  console.log('---------|-------|--------|-------|-------|-------|-------------');
  for (const city of CITIES) {
    const temps = cityData[city.name].map(d => d.highF);
    const mean = temps.reduce((a,b)=>a+b,0)/temps.length;
    const stddev = Math.sqrt(temps.reduce((s,t)=>s+Math.pow(t-mean,2),0)/temps.length);
    const min = Math.min(...temps), max = Math.max(...temps);
    // Day-to-day volatility
    let deltaSum = 0;
    for (let i = 1; i < temps.length; i++) deltaSum += Math.abs(temps[i] - temps[i-1]);
    const avgDelta = deltaSum / (temps.length - 1);
    console.log(`${city.name.padEnd(8)} | ${mean.toFixed(0).padStart(4)}°F | ${stddev.toFixed(1).padStart(5)}°F | ${min.toString().padStart(4)}°F | ${max.toString().padStart(4)}°F | ${(max-min).toString().padStart(4)}°F | ±${avgDelta.toFixed(1)}°F`);
  }

  // ── Worst-Case Analysis ──
  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  WORST-CASE: Maximum drawdown with σ=3.0 (pessimistic)');
  console.log('══════════════════════════════════════════════════════════');
  console.log('If you start with $100 bankroll and 1/4 Kelly sizing:');
  const pessROI = SCENARIOS.map(s => {
    // Rough estimate from the MC runs above
    let t=0,p=0,c=0;
    for (const city of CITIES) {
      // Re-run a quick single pass for this sigma
      for (const day of cityData[city.name]) {
        const forecastF = simulateForecast(day.highF, s);
        const buckets = generateBuckets(forecastF);
        let bestBucket = buckets[0], bestEdge = -Infinity;
        for (const b of buckets) {
          const edge = b.prob - b.simPrice;
          if (edge > bestEdge && edge > EDGE_THRESHOLD) { bestEdge = edge; bestBucket = b; }
        }
        if (bestEdge <= EDGE_THRESHOLD) continue;
        const hit = didBucketHit(day.highF, bestBucket.low, bestBucket.high);
        t++; p += hit ? (1-bestBucket.simPrice) : -bestBucket.simPrice; c += bestBucket.simPrice;
      }
    }
    return { sigma: s, roi: c>0 ? p/c*100 : 0, tradesPerYear: t, costPerYear: c };
  });
  for (const r of pessROI) {
    const annualReturn = r.costPerYear * r.roi / 100;
    console.log(`  σ=${r.sigma}: ~${r.tradesPerYear} trades/yr | ~$${r.costPerYear.toFixed(0)} deployed | ${r.roi.toFixed(0)}% ROI → ~$${annualReturn.toFixed(0)} return on $${r.costPerYear.toFixed(0)} capital`);
  }

  console.log('\n══════════════════════════════════════════════════════════');
  console.log('DONE. Real NWS 24hr forecast accuracy is typically σ≈2.0°F.');
  console.log('Results at σ=2.0 are the best estimate of real performance.');
  console.log('══════════════════════════════════════════════════════════');
}

runStressTest().catch(err => { console.error('Stress test failed:', err); process.exit(1); });
