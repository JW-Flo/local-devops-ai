import { KellyInput, PositionSizing } from './types.js';

export function calculateKelly(input: KellyInput): number {
  const { winProbability: p, marketPrice: cost } = input;
  if (cost <= 0 || cost >= 1 || p <= 0 || p >= 1) return 0;

  const b = (1 / cost) - 1;
  const q = 1 - p;

  const fullKelly = (b * p - q) / b;
  return Math.max(0, fullKelly * input.kellyFraction);
}

export function calculatePositionSize(
  winProbability: number,
  marketPrice: number,
  bankroll: number,
  kellyFraction: number,
  maxPositionPct: number
): PositionSizing {
  const kellyRaw = calculateKelly({ winProbability, marketPrice, kellyFraction: 1.0 });
  const kellyAdjusted = kellyRaw * kellyFraction;

  const kellyDollars = bankroll * kellyAdjusted;
  const maxDollars = bankroll * maxPositionPct;
  const dollarAmount = Math.min(kellyDollars, maxDollars);
  const contracts = Math.floor(dollarAmount / marketPrice);

  return {
    kellyRaw,
    kellyAdjusted,
    dollarAmount,
    contracts: Math.max(0, contracts),
  };
}