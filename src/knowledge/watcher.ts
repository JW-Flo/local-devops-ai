import chokidar from "chokidar";
import { KnowledgeIngester } from "./ingester.js";
import { config } from "../config.js";
import { getAgentState } from "../agent.js";

export function startKnowledgeWatcher() {
  if (!config.watchKnowledge) {
    return;
  }

  const ingester = new KnowledgeIngester();
  let debounceTimer: NodeJS.Timeout | undefined;
  let inFlight = false;

  const scheduleIngest = () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(async () => {
      if (inFlight) return;
      // Skip auto-ingest while agent is running to avoid VRAM contention
      if (getAgentState().running) {
        console.info("[knowledge] skipping auto-ingest (agent running)");
        return;
      }
      inFlight = true;
      try {
        await ingester.ingest();
        console.info("[knowledge] auto-ingest complete");
      } catch (error) {
        console.error("[knowledge] auto-ingest failed", error);
      } finally {
        inFlight = false;
      }
    }, config.knowledgeDebounceMs);
  };

  console.info(`[knowledge] watching ${config.knowledgeRoot}`);
  const watcher = chokidar.watch(config.knowledgeRoot, {
    persistent: true,
    ignoreInitial: true,
  });

  watcher.on("add", scheduleIngest);
  watcher.on("change", scheduleIngest);
  watcher.on("unlink", scheduleIngest);

  // Kick off an initial refresh on boot.
  scheduleIngest();
}
