// Types shared across market-agent modules
// ESM import-safe, no circular dependencies

export type EventType =
  | 'forecast_update'
  | 'orderbook_snapshot'
  | 'mispricing_detected'
  | 'trade_executed'
  | 'trade_rejected'
  | 'paper_trade'
  | 'settlement'
  | 'safety_triggered'
  | 'ws_connected'
  | 'ws_disconnected'
  | 'bot_started'
  | 'bot_stopped';

export interface BaseEvent {
  id?: number;
  event_type: EventType;
  timestamp_ms: number;
  market_ticker?: string;
  payload: Record<string, unknown>;
  created_at?: string;
}

export interface ForecastUpdatePayload {
  city: string;
  target_date: string;
  forecast_high_f: number;
  forecast_time: string;
  model_run: string;
  previous_forecast_high_f: number | null;
  delta_f: number | null;
}

export interface OrderbookSnapshotPayload {
  ticker: string;
  yes_bid: number;
  yes_ask: number;
  yes_bid_size: number;
  yes_ask_size: number;
  volume_24h: number;
  open_interest: number;
}

export interface MispricingPayload {
  ticker: string;
  city: string;
  target_date: string;
  noaa_forecast_f: number;
  noaa_confidence: number;
  bucket_range: [number, number];
  market_price: number;
  implied_prob: number;
  expected_value: number;
  edge: number;
  kelly_fraction: number;
  recommended_contracts: number;
  side: 'yes' | 'no';
  action: 'buy';
}

export interface TradeExecutedPayload {
  order_id: string;
  ticker: string;
  side: 'buy' | 'sell';
  quantity: number;
  price: number;
  total_cost: number;
  rationale: string;
}

export interface SettlementPayload {
  ticker: string;
  result: 'yes' | 'no';
  actual_high_f: number;
  pnl: number;
  source_url?: string;
}

export interface CityConfig {
  name: string;
  lat: number;
  lon: number;
  wfo: string;
  gridX: number;
  gridY: number;
  seriesTicker: string;
}

export interface OrderbookLevel {
  price: number;
  size: number;
}

export interface MarketOrderbook {
  ticker: string;
  yesBids: OrderbookLevel[];
  yesAsks: OrderbookLevel[];
  lastUpdateMs: number;
}

export interface KellyInput {
  winProbability: number;
  marketPrice: number;
  kellyFraction: number;
}

export interface PositionSizing {
  kellyRaw: number;
  kellyAdjusted: number;
  dollarAmount: number;
  contracts: number;
}

export interface TempBucket {
  lower: number;
  upper: number;
  ticker: string;
}

export interface DailyForecast {
  city: string;
  targetDate: string;
  highF: number;
  forecastTime: string;
  modelRun: string;
  seriesTicker: string;
}

export interface MispricingSignal {
  ticker: string;
  city: string;
  targetDate: string;
  noaaForecastF: number;
  noaaConfidence: number;
  bucketRange: [number, number];
  marketPrice: number;      // cost per contract (YES ask for YES-buy, NO ask for NO-buy)
  impliedProb: number;
  expectedValue: number;
  edge: number;
  kellyFraction: number;
  recommendedContracts: number;
  side: 'yes' | 'no';       // which side we're buying
  action: 'buy';            // always buy (YES-buy or NO-buy)
}

export interface SafetyCheck {
  passed: boolean;
  reason?: string;
}

export interface TradeValidation {
  approved: boolean;
  confidence: number;
  reasoning: string;
}

export const CITIES: CityConfig[] = [
  { name: 'NYC', lat: 40.7831, lon: -73.9712, wfo: 'OKX', gridX: 33, gridY: 37, seriesTicker: 'KXHIGHNY' },
  { name: 'LA', lat: 34.0522, lon: -118.2437, wfo: 'LOX', gridX: 154, gridY: 44, seriesTicker: 'KXHIGHLAX' },
  { name: 'Chicago', lat: 41.8781, lon: -87.6298, wfo: 'LOT', gridX: 76, gridY: 73, seriesTicker: 'KXHIGHCHI' },
  { name: 'Miami', lat: 25.7617, lon: -80.1918, wfo: 'MFL', gridX: 109, gridY: 50, seriesTicker: 'KXHIGHMIA' },
  { name: 'Dallas', lat: 32.7767, lon: -96.7970, wfo: 'FWD', gridX: 79, gridY: 108, seriesTicker: 'KXHIGHDFW' },
  { name: 'Denver', lat: 39.7392, lon: -104.9903, wfo: 'BOU', gridX: 63, gridY: 62, seriesTicker: 'KXHIGHDEN' },
  { name: 'Austin', lat: 30.2672, lon: -97.7431, wfo: 'EWX', gridX: 156, gridY: 91, seriesTicker: 'KXHIGHAUS' },
];

export type KalshiRestInterfaceType = Record<string, unknown>;