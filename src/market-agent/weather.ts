import { CityConfig, CITIES, TempBucket } from './types.js';

/**
 * City-specific forecast uncertainty (σ in °F) calibrated against NOAA NWS
 * verification data. Coastal/microclimate cities have higher variance.
 *
 * Calibration basis (observed Mar 2026 paper trading):
 *   NYC: 19°F miss on Mar 29 → σ≈4.0 at 24h
 *   Chicago: 14°F miss on Mar 29 → σ≈3.5 at 24h
 *   Miami: subtropical, stable → σ≈2.5
 *   LA: marine layer variability → σ≈3.0
 *   Dallas/Austin: continental, moderate → σ≈3.0
 *   Denver: mountain effects, high variance → σ≈4.5
 *
 * Each entry: [24h σ, 48h σ, 72h+ σ]
 */
const CITY_SIGMA: Record<string, [number, number, number]> = {
  'New York':  [6.0, 8.0, 10.5],   // was [4.0, 5.5, 7.0] — 1.5× wider; 0/6 win rate showed overconfidence
  'Los Angeles': [4.5, 6.0, 8.0],  // was [3.0, 4.0, 5.5] — marine layer makes tails fatter than modeled
  'Chicago':   [5.0, 7.5, 10.0],   // was [3.5, 5.0, 6.5] — lake effect + continental swings
  'Miami':     [3.5, 5.0, 7.5],    // was [2.5, 3.5, 5.0] — stable but still underestimated
  'Dallas':    [4.5, 6.5, 9.0],    // was [3.0, 4.5, 6.0]
  'Denver':    [6.5, 9.0, 11.0],   // was [4.5, 6.0, 7.5] — mountain variance is extreme
  'Austin':    [4.5, 6.5, 9.0],    // was [3.0, 4.5, 6.0]
};
const DEFAULT_SIGMA: [number, number, number] = [5.0, 7.5, 10.0];

/** Hard cap on model confidence — never claim >85% on any single event */
const MAX_MODEL_CONFIDENCE = 0.85;

export function parseBucketFromTitle(title: string): [number, number] | null {
  // Strip markdown bold markers (Kalshi titles use **text**)
  const clean = title.replace(/\*\*/g, '');

  // Kalshi v2 format: ">69°" (above threshold)
  const gtMatch = clean.match(/>(\d+(?:\.\d+)?)\s*°/);
  if (gtMatch) return [parseFloat(gtMatch[1]), 999];

  // Kalshi v2 format: "<62°" (below threshold)
  const ltMatch = clean.match(/<(\d+(?:\.\d+)?)\s*°/);
  if (ltMatch) return [-999, parseFloat(ltMatch[1])];

  // Legacy: "N or higher / and above"
  const upperMatch = clean.match(/(\d+(?:\.\d+)?)°?\s*(or higher|and above)/i);
  if (upperMatch) return [parseFloat(upperMatch[1]), 999];

  // Legacy: "N or lower / and below"
  const lowerMatch = clean.match(/(\d+(?:\.\d+)?)°?\s*(or lower|and below)/i);
  if (lowerMatch) return [-999, parseFloat(lowerMatch[1])];

  // Range: "68-69°" or "68–69" (Kalshi bucket markets)
  const rangeMatch = clean.match(/(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)/);
  if (rangeMatch) return [parseFloat(rangeMatch[1]), parseFloat(rangeMatch[2])];

  return null;
}

export function getForecastConfidence(hoursAhead: number): number {
  if (hoursAhead <= 24) return 0.94;
  if (hoursAhead <= 36) return 0.91;
  if (hoursAhead <= 48) return 0.88;
  if (hoursAhead <= 72) return 0.82;
  return 0.75;
}

export function findMatchingBucket(
  forecastHighF: number,
  buckets: TempBucket[]
): TempBucket | null {
  for (const bucket of buckets) {
    if (forecastHighF >= bucket.lower && forecastHighF <= bucket.upper) {
      return bucket;
    }
  }
  return null;
}

export function bucketProbability(
  forecastHighF: number,
  bucketLower: number,
  bucketUpper: number,
  hoursAhead: number,
  cityName?: string
): number {
  const sigmas = (cityName && CITY_SIGMA[cityName]) || DEFAULT_SIGMA;
  const stdDev = hoursAhead <= 24 ? sigmas[0] : hoursAhead <= 48 ? sigmas[1] : sigmas[2];

  const phi = (x: number): number => {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989422804014327;
    const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    const cdf = 1.0 - d * Math.exp(-0.5 * x * x) * poly;
    return x >= 0 ? cdf : 1 - cdf;
  };

  const adjLower = bucketLower === -999 ? -50 : bucketLower - 0.5;
  const adjUpper = bucketUpper === 999 ? 200 : bucketUpper + 0.5;

  const zLower = (adjLower - forecastHighF) / stdDev;
  const zUpper = (adjUpper - forecastHighF) / stdDev;

  const raw = Math.max(0, Math.min(1, phi(zUpper) - phi(zLower)));
  // Cap confidence — model should never claim >85% on any single weather event
  return Math.min(raw, MAX_MODEL_CONFIDENCE);
}

export function getCityConfig(name: string): CityConfig | undefined {
  return CITIES.find((c: CityConfig) => c.name === name);
}

export function getCityBySeries(seriesTicker: string): CityConfig | undefined {
  return CITIES.find((c: CityConfig) => c.seriesTicker === seriesTicker);
}