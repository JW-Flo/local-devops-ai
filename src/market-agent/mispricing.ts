import type { Database } from 'sql.js';
import { OrderbookState } from './orderbook.js';
import { DailyForecast, MispricingSignal, MispricingPayload, CITIES, CityConfig } from './types.js';
import { calculatePositionSize } from './kelly.js';
import { bucketProbability, parseBucketFromTitle, getForecastConfidence } from './weather.js';
import { withDb } from '../storage/sqlite.js';

const EDGE_THRESHOLD = 0.10;      // 10 cents minimum edge
const KELLY_FRACTION = 0.25;       // quarter-Kelly
const MAX_POSITION_PCT = 0.25;     // 25% max per market

export class MispricingDetector {
  private currentSignals: MispricingSignal[] = [];

  detectAll(
    orderbook: OrderbookState,
    forecasts: Map<string, DailyForecast>,
    bankroll: number,
    marketMeta: Map<string, { title: string; ticker: string }>
  ): MispricingSignal[] {
    const signals: MispricingSignal[] = [];

    for (const [ticker, meta] of marketMeta) {
      const book = orderbook.getBook(ticker);
      if (!book) continue;

      const bestAsk = book.yesAsks[0]?.price;
      if (!bestAsk || bestAsk <= 0) continue;

      const bucket = parseBucketFromTitle(meta.title);
      if (!bucket) continue;

      const city = CITIES.find((c: CityConfig) => ticker.startsWith(c.seriesTicker));
      if (!city) continue;

      let matchedForecast: DailyForecast | undefined;
      for (const [_, fc] of forecasts) {
        if (fc.city === city.name) {
          matchedForecast = fc;
          break;
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
        hoursAhead
      );

      if (prob < 0.05) continue;

      const expectedValue = prob * 1.0;
      const edge = expectedValue - bestAsk;

      if (edge < EDGE_THRESHOLD) continue;

      const sizing = calculatePositionSize(
        prob,
        bestAsk,
        bankroll,
        KELLY_FRACTION,
        MAX_POSITION_PCT
      );

      if (sizing.contracts <= 0) continue;

      const signal: MispricingSignal = {
        ticker,
        city: city.name,
        targetDate: matchedForecast.targetDate,
        noaaForecastF: matchedForecast.highF,
        noaaConfidence: prob,
        bucketRange: bucket,
        marketPrice: bestAsk,
        impliedProb: bestAsk,
        expectedValue,
        edge,
        kellyFraction: sizing.kellyAdjusted,
        recommendedContracts: sizing.contracts,
      };

      signals.push(signal);

      const payload: MispricingPayload = {
        ticker: signal.ticker,
        city: signal.city,
        target_date: signal.targetDate,
        noaa_forecast_f: signal.noaaForecastF,
        noaa_confidence: signal.noaaConfidence,
        bucket_range: signal.bucketRange,
        market_price: signal.marketPrice,
        implied_prob: signal.impliedProb,
        expected_value: signal.expectedValue,
        edge: signal.edge,
        kelly_fraction: signal.kellyFraction,
        recommended_contracts: signal.recommendedContracts,
      };

      withDb(async (db: Database) => {
        db.run(
          `INSERT INTO events (event_type, timestamp_ms, market_ticker, payload) VALUES (?, ?, ?, ?)`,
          ['mispricing_detected', Date.now(), ticker, JSON.stringify(payload)]
        );
      }, { db: 'market-agent', persist: true });

      console.log(
        `Mispricing: ${ticker} | ${city.name} | ${matchedForecast.highF}°F → ` +
        `prob ${(prob * 100).toFixed(1)}% | price $${bestAsk.toFixed(2)} | ` +
        `edge $${edge.toFixed(3)} | ${sizing.contracts} contracts`
      );
    }

    this.currentSignals = signals;
    return signals;
  }

  getCurrentSignals(): MispricingSignal[] {
    return this.currentSignals;
  }
}