import type { Database } from 'sql.js';
import { CityConfig, CITIES, ForecastUpdatePayload, DailyForecast } from './types.js';
import { withDb } from '../storage/sqlite.js';

const NWS_BASE = 'https://api.weather.gov';
const USER_AGENT = 'market-agent/1.0 (weather-arbitrage-bot)';

interface NWSForecastPeriod {
  number: number;
  name: string;
  startTime: string;
  endTime: string;
  isDaytime: boolean;
  temperature: number;
  temperatureUnit: string;
  windSpeed: string;
  shortForecast: string;
}

interface NWSForecastResponse {
  properties: {
    updateTime: string;
    generatedAt: string;
    periods: NWSForecastPeriod[];
  };
}

function extractDailyHigh(periods: NWSForecastPeriod[], targetDate: string): number | null {
  const dayPeriods = periods.filter((p) => {
    const pDate = p.startTime.slice(0, 10);
    return pDate === targetDate && p.isDaytime;
  });

  if (dayPeriods.length === 0) {
    const allDayPeriods = periods.filter((p) => p.startTime.slice(0, 10) === targetDate);
    if (allDayPeriods.length === 0) return null;
    return Math.max(...allDayPeriods.map((p) => p.temperature));
  }

  return Math.max(...dayPeriods.map((p) => p.temperature));
}

export class NOAAClient {
  private lastForecasts: Map<string, number> = new Map();

  async fetchForecast(city: CityConfig): Promise<NWSForecastResponse | null> {
    const url = `${NWS_BASE}/gridpoints/${city.wfo}/${city.gridX},${city.gridY}/forecast/hourly`;

    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/geo+json',
        },
      });

      if (!res.ok) {
        console.warn(`NWS API error for ${city.name}: ${res.status}`);
        return null;
      }

      return (await res.json()) as NWSForecastResponse;
    } catch (err) {
      console.error(`NWS fetch failed for ${city.name}:`, err);
      return null;
    }
  }

  parseDailyHighs(city: CityConfig, response: NWSForecastResponse): DailyForecast[] {
    const periods = response.properties.periods;
    const updateTime = response.properties.updateTime;
    const generatedAt = response.properties.generatedAt;

    const results: DailyForecast[] = [];

    const now = new Date();
    for (let dayOffset = 1; dayOffset <= 2; dayOffset++) {
      const target = new Date(now);
      target.setDate(target.getDate() + dayOffset);
      const targetDate = target.toISOString().slice(0, 10);

      const highF = extractDailyHigh(periods, targetDate);
      if (highF !== null) {
        results.push({
          city: city.name,
          targetDate,
          highF,
          forecastTime: generatedAt,
          modelRun: updateTime,
          seriesTicker: city.seriesTicker,
        });
      }
    }

    return results;
  }

  async pollAll(): Promise<DailyForecast[]> {
    const allForecasts: DailyForecast[] = [];

    for (const city of CITIES) {
      try {
        const response = await this.fetchForecast(city);
        if (!response) continue;

        const forecasts = this.parseDailyHighs(city, response);
        for (const fc of forecasts) {
          const key = `${fc.city}-${fc.targetDate}`;
          const prev = this.lastForecasts.get(key) ?? null;
          const delta = prev !== null ? fc.highF - prev : null;

          const payload: ForecastUpdatePayload = {
            city: fc.city,
            target_date: fc.targetDate,
            forecast_high_f: fc.highF,
            forecast_time: fc.forecastTime,
            model_run: fc.modelRun,
            previous_forecast_high_f: prev,
            delta_f: delta,
          };

          await withDb(async (db: Database) => {
            db.run(
              `INSERT INTO events (event_type, timestamp_ms, market_ticker, payload)
               VALUES (?, ?, ?, ?)`,
              ['forecast_update', Date.now(), null, JSON.stringify(payload)]
            );
          }, { db: 'market-agent', persist: true });

          this.lastForecasts.set(key, fc.highF);

          if (delta !== null && delta !== 0) {
            console.log(`Forecast change: ${fc.city} ${fc.targetDate} ${fc.highF}°F (delta: ${delta})`);
          }

          allForecasts.push(fc);
        }
      } catch (err) {
        console.error(`Failed to poll city ${city.name}:`, err);
      }
    }

    console.log(`NOAA poll complete: ${allForecasts.length} forecasts`);
    return allForecasts;
  }

  getLatestForecasts(): Map<string, DailyForecast> {
    const result = new Map<string, DailyForecast>();
    for (const [key, highF] of this.lastForecasts) {
      const [city, targetDate] = key.split('-', 2);
      const remaining = key.slice(city.length + 1);
      result.set(key, {
        city,
        targetDate: remaining,
        highF,
        forecastTime: '',
        modelRun: '',
        seriesTicker: CITIES.find((c: CityConfig) => c.name === city)?.seriesTicker || '',
      });
    }
    return result;
  }
}