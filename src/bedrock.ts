import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { config } from "./config.js";
import { reportProviderSuccess, reportProviderFailure, isProviderAvailable } from "./self-healer.js";

let client: BedrockRuntimeClient | null = null;

function getClient(): BedrockRuntimeClient {
  if (!client) {
    client = new BedrockRuntimeClient({ region: config.awsRegion });
  }
  return client;
}

export async function callBedrock(
  system: string,
  user: string,
  opts?: { temp?: number; maxTokens?: number }
): Promise<string> {
  if (!isProviderAvailable("bedrock")) {
    throw new Error("Bedrock circuit-broken (too many failures)");
  }

  const cmd = new ConverseCommand({
    modelId: config.bedrockModel,
    system: [{ text: system }],
    messages: [{ role: "user", content: [{ text: user }] }],
    inferenceConfig: {
      maxTokens: opts?.maxTokens ?? config.maxTokens,
      temperature: opts?.temp ?? config.temperature,
    },
  });

  try {
    const resp = await getClient().send(cmd);
    const text = resp.output?.message?.content?.[0]?.text ?? "";
    const usage = resp.usage;

    console.log(
      `[bedrock] ${config.bedrockModel} | ${usage?.inputTokens ?? 0}in/${usage?.outputTokens ?? 0}out`
    );

    reportProviderSuccess("bedrock");
    return text;
  } catch (err) {
    reportProviderFailure("bedrock", (err as Error).message).catch(() => {});
    throw err;
  }
}
