import { CityConfig, CITIES, TempBucket } from './types.js';

export function parseBucketFromTitle(title: string): [number, number] | null {
  const lowerMatch = title.match(/(\d+)°?\s*(or lower|and below)/i);
  if (lowerMatch) {
    return [-999, parseInt(lowerMatch[1])];
  }

  const upperMatch = title.match(/(\d+)°?\s*(or higher|and above)/i);
  if (upperMatch) {
    return [parseInt(upperMatch[1]), 999];
  }

  const rangeMatch = title.match(/(\d+)°?\s*[-–to]+\s*(\d+)/i);
  if (rangeMatch) {
    return [parseInt(rangeMatch[1]), parseInt(rangeMatch[2])];
  }

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
  hoursAhead: number
): number {
  const stdDev = hoursAhead <= 24 ? 2.0 : hoursAhead <= 48 ? 3.0 : 4.0;

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

  return Math.max(0, Math.min(1, phi(zUpper) - phi(zLower)));
}

export function getCityConfig(name: string): CityConfig | undefined {
  return CITIES.find((c: CityConfig) => c.name === name);
}

export function getCityBySeries(seriesTicker: string): CityConfig | undefined {
  return CITIES.find((c: CityConfig) => c.seriesTicker === seriesTicker);
}