import { config } from "./config.js";
import { knowledgeStore } from "./knowledge/store.js";
import { memoryStore } from "./memory/store.js";
import { clientCount } from "./events.js";

export type SystemMetrics = {
  gateway: { uptime: number; sseClients: number };
  qdrant: { healthy: boolean; points: number; collections: string[] };
  ollama: { healthy: boolean; models: string[]; modelCount: number };
  knowledge: { root: string; watching: boolean; points: number };
  memories: { count: number };
  timestamp: string;
};
const startTime = Date.now();

export async function collectMetrics(): Promise<SystemMetrics> {
  // Qdrant
  let qdrantHealthy = false;
  let qdrantPoints = 0;
  let collections: string[] = [];
  try {
    const cRes = await fetch(`${config.qdrantUrl}/collections`);
    if (cRes.ok) {
      const cData = (await cRes.json()) as any;
      qdrantHealthy = true;
      collections = (cData.result?.collections ?? []).map((c: any) => c.name);
      const stats = await knowledgeStore.stats();
      qdrantPoints = stats.points;
    }
  } catch { /* offline */ }

  // Ollama
  let ollamaHealthy = false;
  let models: string[] = [];
  try {
    const oRes = await fetch(`${config.ollamaHost}/api/tags`);
    if (oRes.ok) {
      const oData = (await oRes.json()) as any;
      ollamaHealthy = true;
      models = (oData.models ?? []).map((m: any) => m.name);
    }
  } catch { /* offline */ }
  // Memories
  let memCount = 0;
  try {
    const mems = await memoryStore.list(9999);
    memCount = mems.length;
  } catch { /* empty */ }

  return {
    gateway: {
      uptime: Math.floor((Date.now() - startTime) / 1000),
      sseClients: clientCount(),
    },
    qdrant: { healthy: qdrantHealthy, points: qdrantPoints, collections },
    ollama: { healthy: ollamaHealthy, models, modelCount: models.length },
    knowledge: {
      root: config.knowledgeRoot,
      watching: config.watchKnowledge,
      points: qdrantPoints,
    },
    memories: { count: memCount },
    timestamp: new Date().toISOString(),
  };
}