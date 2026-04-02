import type { Database } from 'sql.js';
import { OrderbookState } from './orderbook.js';
import { DailyForecast, MispricingSignal, MispricingPayload, CITIES, CityConfig } from './types.js';
import { calculatePositionSize } from './kelly.js';
import { bucketProbability, parseBucketFromTitle, getForecastConfidence } from './weather.js';
import { withDb } from '../storage/sqlite.js';
import type { TickerUpdate } from './kalshi-ws.js';

const MONTH_MAP: Record<string, string> = {
  JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
  JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
};

/** Parse target date from ticker like KXHIGHNY-26MAR30-B64.5 → "2026-03-30" */
function parseDateFromTicker(ticker: string): string | null {
  const m = ticker.match(/-(\d{2})([A-Z]{3})(\d{2})-/);
  if (!m) return null;
  const month = MONTH_MAP[m[2]];
  if (!month) return null;
  return `20${m[1]}-${month}-${m[3].padStart(2, '0')}`;
}

const DEFAULT_EDGE_THRESHOLD = 0.03;  // 3 cents minimum edge (bucket markets)
const THRESHOLD_EDGE_MULTIPLIER = 1.5; // threshold (T) markets require 1.5× edge vs bucket (B) — wider spreads, more uncertainty
const DEFAULT_KELLY_FRACTION = 0.25;  // quarter-Kelly (configurable to half-Kelly via API)
const MAX_POSITION_PCT = 0.25;        // 25% max per market
const NO_BUY_MAX_MODEL_PROB = 0.15;   // only sell against buckets where our model says < 15% probability
const NO_BUY_MIN_YES_BID = 0.06;      // market YES bid must be at least 6¢ for NO trade to have meaningful edge
const MIN_ASK_SIZE = 5;               // skip markets with fewer than 5 contracts available at best ask

export class MispricingDetector {
  private currentSignals: MispricingSignal[] = [];
  private diagnosticRun = false;
  /** Track last logged edge per ticker+side to avoid spamming duplicate events */
  private lastLoggedEdge: Map<string, number> = new Map();
  private readonly EDGE_CHANGE_THRESHOLD = 0.02; // only re-log if edge moved 2¢+
  /** Configurable Kelly fraction — toggle between quarter (0.25) and half (0.50) */
  private kellyFraction = DEFAULT_KELLY_FRACTION;
  private edgeThreshold = DEFAULT_EDGE_THRESHOLD;

  setKellyFraction(f: number): void {
    this.kellyFraction = Math.max(0.05, Math.min(1.0, f));
    console.log(`[mispricing] Kelly fraction set to ${this.kellyFraction}`);
  }
  getKellyFraction(): number { return this.kellyFraction; }

  setEdgeThreshold(t: number): void {
    this.edgeThreshold = Math.max(0.01, Math.min(0.20, t));
    console.log(`[mispricing] Edge threshold set to $${this.edgeThreshold}`);
  }
  getEdgeThreshold(): number { return this.edgeThreshold; }

  detectAll(
    orderbook: OrderbookState,
    forecasts: Map<string, DailyForecast>,
    bankroll: number,
    marketMeta: Map<string, { title: string; ticker: string }>,
    tickerCache?: Map<string, TickerUpdate>,
  ): MispricingSignal[] {
    const signals: MispricingSignal[] = [];
    const todayUTC = new Date().toISOString().slice(0, 10);

    // One-shot diagnostic: log what the detector sees on first run with actual data
    if (!this.diagnosticRun && marketMeta.size > 0) {
      this.diagnosticRun = true;
      const diag = { total: marketMeta.size, withPrice: 0, today: 0, future: 0, noDate: 0, noBucket: 0, samples: [] as string[] };
      for (const [t, m] of marketMeta) {
        const snap = tickerCache?.get(t);
        const hasPrice = snap && snap.yes_ask_dollars > 0;
        if (hasPrice) diag.withPrice++;
        const d = parseDateFromTicker(t);
        if (!d) diag.noDate++;
        else if (d === todayUTC) diag.today++;
        else diag.future++;
        const bucket = parseBucketFromTitle(m.title);
        if (!bucket) diag.noBucket++;
        if (diag.samples.length < 8) {
          diag.samples.push(`${t} date=${d} price=${hasPrice ? snap!.yes_ask_dollars : 'NONE'} bucket=${bucket ? bucket.join('-') : 'NULL'} title="${m.title.slice(0, 60)}"`);
        }
      }
      console.log(`[mispricing-diag] ${JSON.stringify(diag, null, 2)}`);
    }

    for (const [ticker, meta] of marketMeta) {
      // Price: prefer live ticker channel bid/ask; fall back to orderbook depth
      let bestAsk: number | undefined;
      let askSize = 0;
      let bidSize = 0;
      const tickerSnap = tickerCache?.get(ticker);
      if (tickerSnap && tickerSnap.yes_ask_dollars > 0) {
        bestAsk = Number(tickerSnap.yes_ask_dollars);
        askSize = Number(tickerSnap.yes_ask_size || 0);
        bidSize = Number(tickerSnap.yes_bid_size || 0);
      } else {
        const book = orderbook.getBook(ticker);
        if (book?.yesAsks[0]) {
          bestAsk = book.yesAsks[0].price;
          askSize = book.yesAsks[0].size || 0;
        }
        if (book?.yesBids[0]) {
          bidSize = book.yesBids[0].size || 0;
        }
      }
      if (!bestAsk || bestAsk <= 0) continue;

      // ── Liquidity filter: skip illiquid markets ──
      if (askSize < MIN_ASK_SIZE) continue; // not enough depth to trade

      // Skip same-day markets only after 22:00 UTC (6 PM ET) — daily high is locked in by then
      const targetDate = parseDateFromTicker(ticker);
      if (targetDate === todayUTC) {
        const hourUTC = new Date().getUTCHours();
        if (hourUTC >= 22) continue;
      }

      const bucket = parseBucketFromTitle(meta.title);
      if (!bucket) continue;

      const city = CITIES.find((c: CityConfig) => ticker.startsWith(c.seriesTicker));
      if (!city) continue;

      // Match forecast by BOTH city AND target date from ticker
      let matchedForecast: DailyForecast | undefined;
      for (const [_, fc] of forecasts) {
        if (fc.city === city.name && (!targetDate || fc.targetDate === targetDate)) {
          matchedForecast = fc;
          break;
        }
      }
      // Fallback: any forecast for this city if no date match
      if (!matchedForecast) {
        for (const [_, fc] of forecasts) {
          if (fc.city === city.name) { matchedForecast = fc; break; }
        }
      }
      if (!matchedForecast) continue;

      const hoursAhead = Math.max(
        12,
        (new Date(matchedForecast.targetDate).getTime() - Date.now()) / 3600000
      );
      const confidence = getForecastConfidence(hoursAhead);

      const prob = bucketProbability(
        matchedForecast.highF,
        bucket[0],
        bucket[1],
        hoursAhead,
        city.name
      );

      // ── Determine market type: threshold (T) vs bucket (B) ──
      // Threshold markets (e.g., KXHIGHNY-26APR02-T72) have wider spreads and more model uncertainty
      const isThresholdMarket = ticker.includes('-T');
      const effectiveEdgeThreshold = isThresholdMarket
        ? this.edgeThreshold * THRESHOLD_EDGE_MULTIPLIER
        : this.edgeThreshold;

      // ── YES-BUY: model probability exceeds market price ──
      if (prob >= 0.05) {
        const expectedValue = prob * 1.0;
        const edge = expectedValue - bestAsk;

        if (edge >= effectiveEdgeThreshold) {
          const sizing = calculatePositionSize(prob, bestAsk, bankroll, this.kellyFraction, MAX_POSITION_PCT);
          const cappedContracts = Math.min(sizing.contracts, askSize); // cap to available liquidity
          if (cappedContracts <= 0) continue;
          const signal: MispricingSignal = {
            ticker, city: city.name, targetDate: matchedForecast.targetDate,
            noaaForecastF: matchedForecast.highF, noaaConfidence: prob,
            bucketRange: bucket, marketPrice: bestAsk, impliedProb: bestAsk,
            expectedValue, edge, kellyFraction: sizing.kellyAdjusted,
            recommendedContracts: cappedContracts, side: 'yes', action: 'buy',
          };
          signals.push(signal);
          this.logSignalIfNew(signal, `YES-BUY`, city.name, matchedForecast.highF, prob, bestAsk, edge, sizing.contracts);
        }
      }

      // ── NO-BUY: model says bucket is unlikely, but market overprices YES ──
      // Buy NO contracts on tail buckets where the market thinks probability is higher than our model
      // Example: model says 3% chance, market YES bid = 8¢ → NO cost ≈ 92¢, EV = 97¢, edge = 5¢
      // YES bid price for NO-BUY calculation: prefer WS, fall back to orderbook
      let yesBid = tickerSnap?.yes_bid_dollars ?? 0;
      if (!yesBid) {
        const book = orderbook.getBook(ticker);
        yesBid = book?.yesBids[0]?.price ?? 0;
      }
      if (prob < NO_BUY_MAX_MODEL_PROB && yesBid >= NO_BUY_MIN_YES_BID) {
        const noPrice = 1 - yesBid;            // approximate NO ask price
        const winProb = 1 - prob;               // probability bucket does NOT hit
        const noEV = winProb * 1.0;
        const noEdge = noEV - noPrice;

        if (noEdge >= effectiveEdgeThreshold) {
          if (bidSize < MIN_ASK_SIZE) continue; // not enough liquidity on bid side for NO trade
          const noSizing = calculatePositionSize(winProb, noPrice, bankroll, this.kellyFraction, MAX_POSITION_PCT);
          const noCappedContracts = Math.min(noSizing.contracts, bidSize);
          if (noCappedContracts <= 0) continue;
          const noSignal: MispricingSignal = {
            ticker, city: city.name, targetDate: matchedForecast.targetDate,
            noaaForecastF: matchedForecast.highF, noaaConfidence: winProb,
            bucketRange: bucket, marketPrice: noPrice, impliedProb: 1 - yesBid,
            expectedValue: noEV, edge: noEdge, kellyFraction: noSizing.kellyAdjusted,
            recommendedContracts: noCappedContracts, side: 'no', action: 'buy',
          };
          signals.push(noSignal);
          this.logSignalIfNew(noSignal, `NO-BUY`, city.name, matchedForecast.highF, prob, noPrice, noEdge, noSizing.contracts);
        }
      }
    }

    this.currentSignals = signals;
    return signals;
  }

  private logSignalIfNew(
    signal: MispricingSignal, label: string, cityName: string,
    forecastF: number, prob: number, price: number, edge: number, contracts: number
  ): void {
    const key = `${signal.ticker}:${signal.side}`;
    const prevEdge = this.lastLoggedEdge.get(key);
    const isNew = prevEdge === undefined;
    const edgeMoved = prevEdge !== undefined && Math.abs(edge - prevEdge) >= this.EDGE_CHANGE_THRESHOLD;

    if (isNew || edgeMoved) {
      this.lastLoggedEdge.set(key, edge);

      const payload: MispricingPayload = {
        ticker: signal.ticker, city: signal.city, target_date: signal.targetDate,
        noaa_forecast_f: signal.noaaForecastF, noaa_confidence: signal.noaaConfidence,
        bucket_range: signal.bucketRange, market_price: signal.marketPrice,
        implied_prob: signal.impliedProb, expected_value: signal.expectedValue,
        edge: signal.edge, kelly_fraction: signal.kellyFraction,
        recommended_contracts: signal.recommendedContracts,
        side: signal.side, action: signal.action,
      };

      withDb(async (db: Database) => {
        db.run(
          `INSERT INTO events (event_type, timestamp_ms, market_ticker, payload) VALUES (?, ?, ?, ?)`,
          ['mispricing_detected', Date.now(), signal.ticker, JSON.stringify(payload)]
        );
      }, { db: 'market-agent', persist: true });

      console.log(
        `${label}: ${signal.ticker} | ${cityName} | ${forecastF}°F → ` +
        `prob ${(prob * 100).toFixed(1)}% | price $${price.toFixed(2)} | ` +
        `edge $${edge.toFixed(3)} | ${contracts} contracts`
      );
    }
  }

  getCurrentSignals(): MispricingSignal[] {
    return this.currentSignals;
  }
}