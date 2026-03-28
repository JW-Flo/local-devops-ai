import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

type Config = {
  port: number;
  ollamaHost: string;
  primaryModel: string;
  codeModel: string;
  fastModel: string;
  embedModel: string;
  embedDimensions: number;
  qdrantUrl: string;
  knowledgeRoot: string;
  workspaceRoot: string;
  cacheDir: string;
  defaultApprover: string;
  maxTokens: number;
  temperature: number;
  watchKnowledge: boolean;
  knowledgeDebounceMs: number;
  ghPat?: string;
  kubeconfigPath?: string;
  ansibleInventory?: string;
  prometheusUrl?: string;
  lokiUrl?: string;
  grafanaUrl?: string;
  // AWS Bedrock
  awsRegion: string;
  bedrockModel: string;
  useBedrock: boolean;
  // OpenRouter
  openrouterApiKey?: string;
  openrouterModel: string;
  useOpenRouter: boolean;
  // Provider priority: bedrock > openrouter > ollama
  llmProvider: "bedrock" | "openrouter" | "ollama" | "auto";
  // Agent loop
  agentLoopEnabled: boolean;
  agentLoopIntervalMs: number;
  agentLoopMaxApiCalls: number;
  // Knowledge fetcher
  knowledgeFetchEnabled: boolean;
  knowledgeFetchIntervalMs: number;
  // Database
  dbRoot: string;
  // Market Agent
  kalshiEmail?: string;
  kalshiPassword?: string;
  kalshiBaseUrl: string;
  discordWebhookUrl?: string;
};

function loadEnvFile() {
  const envPath = resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) return;
  const raw = readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [key, ...rest] = trimmed.split("=");
    const value = rest.join("=");
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadEnvFile();

function resolveLLMProvider(): "bedrock" | "openrouter" | "ollama" {
  const explicit = process.env.LLM_PROVIDER;
  if (explicit === "bedrock" || explicit === "openrouter" || explicit === "ollama") return explicit;

  // Auto-detect: prefer bedrock if configured, then openrouter, then ollama
  if (process.env.USE_BEDROCK !== "0" && process.env.AWS_ACCESS_KEY_ID) return "bedrock";
  if (process.env.OPENROUTER_API_KEY) return "openrouter";
  return "ollama";
}

export const config: Config = {
  port: Number(process.env.PORT ?? 4123),
  ollamaHost: process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434",
  primaryModel: process.env.PRIMARY_MODEL ?? "llama3.1:8b-instruct-q4_K_M",
  codeModel: process.env.CODE_MODEL ?? "deepseek-coder:6.7b-base-q4_K_M",
  fastModel: process.env.FAST_MODEL ?? "qwen2.5:3b-instruct-q4_K_M",
  embedModel: process.env.EMBED_MODEL ?? "nomic-embed-text:latest",
  embedDimensions: Number(process.env.EMBED_DIMENSIONS ?? 768),
  qdrantUrl: process.env.QDRANT_URL ?? "http://127.0.0.1:6333",
  knowledgeRoot: process.env.KNOWLEDGE_ROOT ?? "D:/ai-knowledge",
  workspaceRoot: process.env.WORKSPACE_ROOT ?? "D:/repos",
  cacheDir: process.env.CACHE_DIR ?? "D:/ai-cache",
  defaultApprover: process.env.DEFAULT_APPROVER ?? "local-admin",
  maxTokens: Number(process.env.MAX_TOKENS ?? 2048),
  temperature: Number(process.env.TEMPERATURE ?? 0.15),
  watchKnowledge: process.env.WATCH_KNOWLEDGE !== "0",
  knowledgeDebounceMs: Number(process.env.KNOWLEDGE_DEBOUNCE_MS ?? 5000),
  ghPat: process.env.GH_PAT,
  kubeconfigPath: process.env.KUBECONFIG_PATH,
  ansibleInventory: process.env.ANSIBLE_DEFAULT_INVENTORY,
  prometheusUrl: process.env.PROMETHEUS_URL,
  lokiUrl: process.env.LOKI_URL,
  grafanaUrl: process.env.GRAFANA_URL,
  // AWS Bedrock
  awsRegion: process.env.AWS_REGION ?? "us-east-1",
  bedrockModel: process.env.BEDROCK_MODEL ?? "us.anthropic.claude-3-5-haiku-20241022-v1:0",
  useBedrock: process.env.USE_BEDROCK !== "0" && !!process.env.AWS_ACCESS_KEY_ID,
  // OpenRouter
  openrouterApiKey: process.env.OPENROUTER_API_KEY,
  openrouterModel: process.env.OPENROUTER_MODEL ?? "meta-llama/llama-3.1-8b-instruct:free",
  useOpenRouter: !!process.env.OPENROUTER_API_KEY,
  // Provider routing
  llmProvider: resolveLLMProvider(),
  // Agent loop
  agentLoopEnabled: process.env.AGENT_LOOP_ENABLED === "1",
  agentLoopIntervalMs: Number(process.env.AGENT_LOOP_INTERVAL_MS ?? 30 * 60 * 1000),
  agentLoopMaxApiCalls: Number(process.env.AGENT_LOOP_MAX_API_CALLS ?? 100),
  // Knowledge fetcher
  knowledgeFetchEnabled: process.env.KNOWLEDGE_FETCH_ENABLED === "1",
  knowledgeFetchIntervalMs: Number(process.env.KNOWLEDGE_FETCH_INTERVAL_MS ?? 60 * 60 * 1000),
  // Database
  dbRoot: process.env.DB_ROOT ?? "D:/ai-knowledge/databases",
  // Market Agent
  kalshiEmail: process.env.KALSHI_EMAIL,
  kalshiPassword: process.env.KALSHI_PASSWORD,
  kalshiBaseUrl: process.env.KALSHI_BASE_URL ?? "https://trading-api.kalshi.com",
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL,
};
