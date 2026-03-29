import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { config } from '../config.js';
import { MispricingSignal, TradeValidation } from './types.js';

const bedrock = new BedrockRuntimeClient({ region: config.awsRegion || 'us-east-1' });

export async function validateWithHaiku(signal: MispricingSignal): Promise<TradeValidation> {
  const prompt = `You are a trading risk validator for a weather arbitrage bot on Kalshi.

Evaluate this trade signal and respond with JSON only (no markdown, no code fences):

City: ${signal.city}
Target Date: ${signal.targetDate}
NOAA Forecast: ${signal.noaaForecastF}°F
Estimated Probability: ${(signal.noaaConfidence * 100).toFixed(1)}%
Kalshi Bucket: ${signal.bucketRange[0]}°F to ${signal.bucketRange[1]}°F
Market Price: $${signal.marketPrice.toFixed(2)}
Calculated Edge: $${signal.edge.toFixed(3)}
Kelly Position: ${signal.recommendedContracts} contracts

Consider:
1. Is the edge sufficient given forecast uncertainty (±2°F at 24hr, ±3°F at 48hr)?
2. Any extreme weather risk that could invalidate the forecast?
3. Is the position size appropriate relative to the edge?

Respond with this exact JSON format:
{"approved": true, "confidence": 85, "reasoning": "brief explanation"}`;

  try {
    const response = await bedrock.send(
      new InvokeModelCommand({
        modelId: 'anthropic.claude-3-haiku-20240307-v1:0',
        contentType: 'application/json',
        body: JSON.stringify({
          anthropic_version: 'bedrock-2023-05-31',
          max_tokens: 200,
          temperature: 0,
          messages: [{ role: 'user', content: prompt }],
        }),
      })
    );

    const body = JSON.parse(new TextDecoder().decode(response.body));
    const text = body.content[0].text.trim();

    const jsonStr = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    const result = JSON.parse(jsonStr) as TradeValidation;

    console.log(`Haiku validation for ${signal.ticker}: approved=${result.approved} confidence=${result.confidence}`);

    return result;
  } catch (err) {
    console.error(`Haiku validation failed for ${signal.ticker}:`, err);
    return {
      approved: false,
      confidence: 0,
      reasoning: `Validation error: ${(err as Error).message}`,
    };
  }
}