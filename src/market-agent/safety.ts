import { MispricingSignal, SafetyCheck } from './types.js';

const MAX_DAILY_LOSS_PCT = 0.15;   // 15% daily loss limit
const MAX_POSITION_PCT = 0.25;     // 25% max per market
const MAX_EXPOSURE_PCT = 0.80;     // 80% max total

export class SafetyGuard {
  private dailyPnL = 0;
  private positions: Map<string, { contracts: number; avgPrice: number }> = new Map();
  private killed = false;
  private dailyResetDate: string = '';

  checkPreTrade(signal: MispricingSignal, bankroll: number): SafetyCheck {
    this.maybeResetDaily();

    if (this.killed) {
      return { passed: false, reason: 'Kill switch active' };
    }

    if (this.dailyPnL < -(bankroll * MAX_DAILY_LOSS_PCT)) {
      return { passed: false, reason: `Daily loss limit exceeded: $${this.dailyPnL.toFixed(2)}` };
    }

    const current = this.positions.get(signal.ticker);
    const currentContracts = current?.contracts || 0;
    const newExposure = (currentContracts + signal.recommendedContracts) * signal.marketPrice;
    if (newExposure > bankroll * MAX_POSITION_PCT) {
      return { passed: false, reason: `Position limit exceeded` };
    }

    const totalExposure = this.calculateTotalExposure() + (signal.recommendedContracts * signal.marketPrice);
    if (totalExposure > bankroll * MAX_EXPOSURE_PCT) {
      return { passed: false, reason: `Total exposure limit exceeded` };
    }

    const activeCities = new Set<string>();
    for (const [ticker] of this.positions) {
      const cityMatch = ticker.match(/^KXHIGH(NY|LAX|CHI|MIA|DFW)/);
      if (cityMatch) activeCities.add(cityMatch[1]);
    }
    const signalCity = signal.ticker.match(/^KXHIGH(NY|LAX|CHI|MIA|DFW)/)?.[1];
    if (signalCity && !activeCities.has(signalCity) && activeCities.size >= 2) {
      return { passed: false, reason: `Correlation limit: already exposed to ${activeCities.size} cities` };
    }

    return { passed: true };
  }

  recordTrade(ticker: string, contracts: number, price: number): void {
    const existing = this.positions.get(ticker);
    if (existing) {
      const totalContracts = existing.contracts + contracts;
      const totalCost = existing.contracts * existing.avgPrice + contracts * price;
      existing.contracts = totalContracts;
      existing.avgPrice = totalCost / totalContracts;
    } else {
      this.positions.set(ticker, { contracts, avgPrice: price });
    }
  }

  recordSettlement(ticker: string, pnl: number): void {
    this.dailyPnL += pnl;
    this.positions.delete(ticker);
    console.log(`Settlement: ${ticker} | pnl=${pnl} | dailyPnL=${this.dailyPnL}`);
  }

  private calculateTotalExposure(): number {
    let total = 0;
    for (const [_, pos] of this.positions) {
      total += pos.contracts * pos.avgPrice;
    }
    return total;
  }

  private maybeResetDaily(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.dailyResetDate) {
      this.dailyPnL = 0;
      this.dailyResetDate = today;
    }
  }

  kill(): void {
    this.killed = true;
    console.warn('KILL SWITCH ACTIVATED');
  }

  reset(): void {
    this.killed = false;
    this.dailyPnL = 0;
    console.log('Safety guard reset');
  }

  isKilled(): boolean {
    return this.killed;
  }

  getPositions(): Map<string, { contracts: number; avgPrice: number }> {
    return new Map(this.positions);
  }

  getDailyPnL(): number {
    return this.dailyPnL;
  }

  getStatus(): {
    killed: boolean;
    dailyPnL: number;
    totalExposure: number;
    positionCount: number;
    activeCities: string[];
  } {
    const activeCities = new Set<string>();
    for (const [ticker] of this.positions) {
      const m = ticker.match(/^KXHIGH(NY|LAX|CHI|MIA|DFW)/);
      if (m) activeCities.add(m[1]);
    }

    return {
      killed: this.killed,
      dailyPnL: this.dailyPnL,
      totalExposure: this.calculateTotalExposure(),
      positionCount: this.positions.size,
      activeCities: Array.from(activeCities),
    };
  }
}