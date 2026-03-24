// Prevent unhandled rejections from crashing the gateway
process.on("unhandledRejection", (err) => {
  console.error("[FATAL] Unhandled rejection:", err);
});
process.on("uncaughtException", (err) => {
  console.error("[FATAL] Uncaught exception:", err);
});

import express from "express";
import cors from "cors";
import { z } from "zod";
import { config } from "./config.js";
import { TaskSchema } from "./task-schema.js";
import { TaskOrchestrator } from "./orchestrator.js";
import { Scheduler } from "./scheduler/scheduler.js";
import { memoryStore } from "./memory/store.js";
import { startKnowledgeWatcher } from "./knowledge/watcher.js";
import { knowledgeStore } from "./knowledge/store.js";
import { KnowledgeIngester } from "./knowledge/ingester.js";
import { githubTool, getRegistry, addRepo, removeRepo } from "./tools/github.js";
import { addSSEClient, broadcast } from "./events.js";
import { collectMetrics } from "./metrics.js";
import { runAgent, getAgentState, resetAgentState } from "./agent.js";
import { executeCodeTask } from "./coding-agent.js";
import {
  startAgentLoop, stopAgentLoop, getAgentLoopState, updateLoopConfig,
} from "./agent-loop.js";
import {
  dispatchTasks, getDispatchConfig, updateDispatchConfig, getLastDispatch, isDispatching,
} from "./task-dispatcher.js";
import { updateRoadmaps } from "./roadmap-updater.js";
import {
  remediateTask, getRemediationLog, getRemediationStats, clearRemediationLog,
} from "./task-remediator.js";
import {
  loadSources, saveSources, fetchAllSources, type KnowledgeSource,
} from "./knowledge/fetcher.js";
import {
  runStartupChecks, startWatchdog, logIssue, resolvePortConflict,
  getIssues, getHealerStats, getProviderHealth, getServiceStates,
} from "./self-healer.js";
import {
  getStats as getRateLimiterStats,
  resetRateLimiter,
} from "./rate-limiter.js";
import {
  initKPITracker, getKPIDashboard, getCycleHistory, resetKPIs,
} from "./kpi-tracker.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

const orchestrator = new TaskOrchestrator();
const scheduler = new Scheduler(orchestrator);
const knowledgeIngester = new KnowledgeIngester();

// ── Health & Metrics ──

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    llmProvider: config.llmProvider,
    openrouterModel: config.openrouterModel,
    bedrockModel: config.bedrockModel,
  });
});

app.get("/metrics", async (_req, res) => {
  try {
    const metrics = await collectMetrics();
    res.json({ status: "success", data: metrics });
  } catch (err) {
    res.status(500).json({ status: "error", message: (err as Error).message });
  }
});

// ── SSE Event Stream ──

app.get("/events", (req, res) => {
  addSSEClient(res);
  collectMetrics().then((m) => {
    const msg = `event: metrics\ndata: ${JSON.stringify({ type: "metrics", data: m, timestamp: new Date().toISOString() })}\n\n`;
    try { res.write(msg); } catch { /* disconnected */ }
  });
});

setInterval(async () => {
  try { const m = await collectMetrics(); broadcast("metrics", m); } catch { /* silent */ }
}, 30_000);

// ── Tasks ──

app.post("/tasks", async (req, res) => {
  const parse = TaskSchema.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ status: "error", details: parse.error.flatten() });
  try {
    broadcast("task:submitted", { objective: parse.data.objective, type: parse.data.type });
    const result = await orchestrator.submit(parse.data);
    if ("status" in result && result.status === "pending") {
      res.json({ status: "pending", data: result.pending });
    } else {
      broadcast("task:completed", { objective: parse.data.objective });
      res.json({ status: "success", data: result });
    }
  } catch (err) {
    broadcast("task:failed", { objective: parse.data.objective, error: (err as Error).message });
    res.status(500).json({ status: "error", message: err instanceof Error ? err.message : "Unknown error" });
  }
});

// ── Approvals ──

app.get("/approvals", (_req, res) => res.json({ status: "success", data: orchestrator.listApprovals() }));

app.post("/approvals/:id/approve", async (req, res) => {
  try { res.json({ status: "success", data: await orchestrator.approve(req.params.id) }); }
  catch (err) { res.status(404).json({ status: "error", message: (err as Error).message }); }
});

app.post("/approvals/:id/reject", (req, res) => {
  const removed = orchestrator.reject(req.params.id);
  if (!removed) return res.status(404).json({ status: "error", message: "Approval not found" });
  res.json({ status: "success", data: { id: req.params.id, rejected: true } });
});

// ── Schedules ──

app.get("/schedules", (_req, res) => res.json({ status: "success", data: scheduler.list() }));

app.post("/schedules", (req, res) => {
  const cronExpr = req.body?.cron;
  const parse = TaskSchema.safeParse(req.body?.task);
  if (!cronExpr || typeof cronExpr !== "string") return res.status(400).json({ status: "error", message: "cron expression required" });
  if (!parse.success) return res.status(400).json({ status: "error", details: parse.error.flatten() });
  try { res.json({ status: "success", data: scheduler.add(cronExpr, parse.data) }); }
  catch (err) { res.status(500).json({ status: "error", message: (err as Error).message }); }
});

app.delete("/schedules/:id", (req, res) => {
  const removed = scheduler.remove(req.params.id);
  if (!removed) return res.status(404).json({ status: "error", message: "Schedule not found" });
  res.json({ status: "success", data: { id: req.params.id, deleted: true } });
});

// ── Knowledge ──

const MemorySchema = z.object({
  title: z.string().min(3), details: z.string().min(3),
  tags: z.array(z.string()).optional(), source: z.string().optional(),
});

app.get("/knowledge", async (_req, res) => {
  let stats = { points: 0 }, healthy = true;
  try { stats = await knowledgeStore.stats(); } catch { healthy = false; }
  res.json({ status: "success", data: { root: config.knowledgeRoot, watch: config.watchKnowledge, points: stats.points, qdrantHealthy: healthy } });
});

app.post("/knowledge/ingest", async (_req, res) => {
  try {
    broadcast("ingest:progress", { status: "started" });
    await knowledgeIngester.ingest();
    broadcast("ingest:complete", { status: "done" });
  } catch (error) {
    return res.status(500).json({ status: "error", message: error instanceof Error ? error.message : "Ingest failed" });
  }
  let stats = { points: 0 };
  try { stats = await knowledgeStore.stats(); } catch { /* silent */ }
  res.json({ status: "success", data: { points: stats.points } });
});

// ── Knowledge Sources (auto-fetch external docs) ──

app.get("/knowledge/sources", (_req, res) => {
  res.json({ status: "success", data: loadSources() });
});

app.post("/knowledge/sources", (req, res) => {
  const { id, type, target, dir, include, enabled } = req.body;
  if (!id || !type || !target || !dir) {
    return res.status(400).json({ status: "error", message: "id, type, target, dir required" });
  }
  const sources = loadSources();
  const existing = sources.findIndex((s) => s.id === id);
  const source: KnowledgeSource = { id, type, target, dir, include, enabled: enabled ?? true };
  if (existing >= 0) {
    sources[existing] = source;
  } else {
    sources.push(source);
  }
  saveSources(sources);
  res.json({ status: "success", data: source });
});

app.delete("/knowledge/sources/:id", (req, res) => {
  const sources = loadSources();
  const idx = sources.findIndex((s) => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ status: "error", message: "Source not found" });
  sources.splice(idx, 1);
  saveSources(sources);
  res.json({ status: "success", data: { deleted: true } });
});

app.post("/knowledge/fetch", async (_req, res) => {
  try {
    const result = await fetchAllSources();
    // Auto-ingest after fetch
    if (result.fetched > 0) {
      await knowledgeIngester.ingest();
    }
    let stats = { points: 0 };
    try { stats = await knowledgeStore.stats(); } catch { /* silent */ }
    res.json({ status: "success", data: { ...result, points: stats.points } });
  } catch (err) {
    res.status(500).json({ status: "error", message: (err as Error).message });
  }
});

// ── Memories ──

app.get("/memories", async (req, res) => {
  const limit = Number(req.query.limit ?? 50);
  res.json({ status: "success", data: await memoryStore.list(Number.isNaN(limit) ? 50 : limit) });
});

app.post("/memories", async (req, res) => {
  const parse = MemorySchema.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ status: "error", details: parse.error.flatten() });
  res.json({ status: "success", data: await memoryStore.add(parse.data) });
});

// ── Orchestrator Agent ──

app.get("/agent/state", (_req, res) => res.json({ status: "success", data: getAgentState() }));

app.post("/agent/reset", (_req, res) => {
  resetAgentState();
  res.json({ status: "success", data: getAgentState() });
});

app.post("/agent/run", async (_req, res) => {
  try { res.json({ status: "success", data: await runAgent() }); }
  catch (err) { res.status(500).json({ status: "error", message: (err as Error).message }); }
});

// ── Continuous Agent Loop ──

app.get("/agent/loop", (_req, res) => {
  res.json({ status: "success", data: getAgentLoopState() });
});

app.post("/agent/loop/start", (req, res) => {
  const intervalMs = req.body?.intervalMs;
  res.json({ status: "success", data: startAgentLoop(intervalMs) });
});

app.post("/agent/loop/stop", (_req, res) => {
  res.json({ status: "success", data: stopAgentLoop() });
});

app.put("/agent/loop/config", (req, res) => {
  const { intervalMs, dispatchEnabled } = req.body;
  res.json({ status: "success", data: updateLoopConfig({ intervalMs, dispatchEnabled }) });
});

// ── Coding Agent ──

app.post("/agent/code", async (req, res) => {
  const { taskId, owner, repo, dryRun } = req.body;
  const agentState = getAgentState();
  const task = agentState.generatedTasks.find((t) => t.id === taskId);
  if (!task) return res.status(404).json({ status: "error", message: `Task ${taskId} not found. Run /agent/run first.` });
  if (!owner || !repo) return res.status(400).json({ status: "error", message: "owner and repo required" });
  try {
    const result = await executeCodeTask(task, owner, repo, { dryRun: dryRun ?? true });
    res.json({ status: "success", data: result });
  } catch (err) {
    res.status(500).json({ status: "error", message: (err as Error).message });
  }
});

app.post("/agent/code-all", async (req, res) => {
  const { owner, repo, dryRun } = req.body;
  if (!owner || !repo) return res.status(400).json({ status: "error", message: "owner and repo required" });
  const agentState = getAgentState();
  const codeTasks = agentState.generatedTasks.filter((t) => t.type === "code");
  if (!codeTasks.length) return res.status(404).json({ status: "error", message: "No code tasks. Run /agent/run first." });
  const results = [];
  for (const task of codeTasks) {
    const result = await executeCodeTask(task, owner, repo, { dryRun: dryRun ?? true });
    results.push(result);
  }
  res.json({ status: "success", data: { total: results.length, succeeded: results.filter((r) => r.success).length, results } });
});

// ── Task Dispatcher ──

app.get("/agent/dispatch", (_req, res) => {
  res.json({
    status: "success",
    data: {
      config: getDispatchConfig(),
      lastDispatch: getLastDispatch(),
      dispatching: isDispatching(),
    },
  });
});

app.post("/agent/dispatch", async (req, res) => {
  if (isDispatching()) {
    return res.status(409).json({ status: "error", message: "Dispatch already in progress" });
  }
  const opts = req.body ?? {};
  try {
    const result = await dispatchTasks(opts);
    res.json({ status: "success", data: result });
  } catch (err) {
    res.status(500).json({ status: "error", message: (err as Error).message });
  }
});

app.put("/agent/dispatch/config", (req, res) => {
  res.json({ status: "success", data: updateDispatchConfig(req.body) });
});

app.post("/agent/roadmap-update", async (_req, res) => {
  try {
    const results = await updateRoadmaps();
    res.json({ status: "success", data: results });
  } catch (err) {
    res.status(500).json({ status: "error", message: (err as Error).message });
  }
});

// ── Task Remediation ──

app.get("/agent/remediation", (_req, res) => {
  res.json({
    status: "success",
    data: { stats: getRemediationStats(), log: getRemediationLog() },
  });
});

app.post("/agent/remediation", async (req, res) => {
  const { taskId, owner, repo, dryRun } = req.body;
  const agentState = getAgentState();
  const task = agentState.generatedTasks.find((t) => t.id === taskId);
  if (!task) return res.status(404).json({ status: "error", message: `Task ${taskId} not found` });
  if (!owner || !repo) return res.status(400).json({ status: "error", message: "owner and repo required" });
  try {
    const record = await remediateTask(task, owner, repo, "Manual remediation trigger", { dryRun: dryRun ?? true });
    res.json({ status: "success", data: record });
  } catch (err) {
    res.status(500).json({ status: "error", message: (err as Error).message });
  }
});

app.delete("/agent/remediation", (_req, res) => {
  clearRemediationLog();
  res.json({ status: "success", data: { cleared: true } });
});

// ── Memory Search ──

app.get("/memories/search", async (req, res) => {
  const q = String(req.query.q ?? "");
  const tags = req.query.tags ? String(req.query.tags).split(",") : undefined;
  const source = req.query.source ? String(req.query.source) : undefined;
  const limit = Number(req.query.limit ?? 10);
  try {
    const results = await memoryStore.search(q, { tags, source, limit });
    res.json({ status: "success", data: results });
  } catch (err) {
    res.status(500).json({ status: "error", message: (err as Error).message });
  }
});

app.get("/memories/semantic", async (req, res) => {
  const q = String(req.query.q ?? "");
  if (!q) return res.status(400).json({ status: "error", message: "q parameter required" });
  const source = req.query.source ? String(req.query.source) : undefined;
  const limit = Number(req.query.limit ?? 10);
  try {
    const results = await memoryStore.semanticSearch(q, { source, limit });
    res.json({ status: "success", data: results });
  } catch (err) {
    res.status(500).json({ status: "error", message: (err as Error).message });
  }
});

app.get("/memories/stats", async (_req, res) => {
  try {
    const stats = await memoryStore.vectorStats();
    const sqliteCount = (await memoryStore.list(1)).length > 0 ? "has entries" : "empty";
    res.json({ status: "success", data: { ...stats, sqlite: sqliteCount } });
  } catch (err) {
    res.status(500).json({ status: "error", message: (err as Error).message });
  }
});

// Auth Status (PAT-only)

app.get("/auth/status", (_req, res) => {
  res.json({
    status: "success",
    data: { method: config.ghPat ? "pat" : "none" },
  });
});

// ── LLM Provider Status ──

app.get("/llm/status", (_req, res) => {
  res.json({
    status: "success",
    data: {
      activeProvider: config.llmProvider,
      bedrock: {
        enabled: config.useBedrock,
        model: config.bedrockModel,
        region: config.awsRegion,
      },
      openrouter: {
        enabled: config.useOpenRouter,
        model: config.openrouterModel,
        hasKey: !!config.openrouterApiKey,
      },
      ollama: {
        host: config.ollamaHost,
        primaryModel: config.primaryModel,
        fastModel: config.fastModel,
        codeModel: config.codeModel,
      },
    },
  });
});

// ── LLM Usage & Rate Limit Intelligence ──

app.get("/llm/usage", (_req, res) => {
  res.json({ status: "success", data: getRateLimiterStats() });
});

app.post("/llm/usage/reset", (_req, res) => {
  resetRateLimiter();
  res.json({ status: "success", message: "Rate limiter state reset" });
});

// ── GitHub Connector (dynamic owner/repo) ──

app.get("/github/registry", (_req, res) => {
  res.json({ status: "success", data: getRegistry() });
});

app.post("/github/registry", (req, res) => {
  const { owner, name } = req.body;
  if (!owner || !name) return res.status(400).json({ status: "error", message: "owner and name required" });
  res.json({ status: "success", data: addRepo(owner, name) });
});

app.delete("/github/registry/:owner/:name", (req, res) => {
  const removed = removeRepo(req.params.owner, req.params.name);
  if (!removed) return res.status(404).json({ status: "error", message: "Repo not found in registry" });
  res.json({ status: "success", data: { removed: true } });
});

app.get("/github/discover/:owner", async (req, res) => {
  try {
    const repos = await githubTool.discoverOrgRepos(req.params.owner);
    res.json({ status: "success", data: repos });
  } catch (err) { res.status(500).json({ status: "error", message: (err as Error).message }); }
});

app.get("/github/repos", async (_req, res) => {
  try { res.json({ status: "success", data: await githubTool.listRepos() }); }
  catch (err) { res.status(500).json({ status: "error", message: (err as Error).message }); }
});

app.get("/github/tree/:owner/:repo", async (req, res) => {
  try {
    const branch = req.query.branch as string | undefined;
    res.json({ status: "success", data: await githubTool.getTree(req.params.owner, req.params.repo, branch) });
  } catch (err) { res.status(500).json({ status: "error", message: (err as Error).message }); }
});

app.get("/github/file/:owner/:repo/*", async (req, res) => {
  try {
    const filePath = (req.params as Record<string, string>)[0];
    const branch = req.query.branch as string | undefined;
    res.json({ status: "success", data: await githubTool.getFile(req.params.owner, req.params.repo, filePath, branch) });
  } catch (err) { res.status(500).json({ status: "error", message: (err as Error).message }); }
});

app.get("/github/summary/:owner/:repo", async (req, res) => {
  try { res.json({ status: "success", data: await githubTool.getRepoSummary(req.params.owner, req.params.repo) }); }
  catch (err) { res.status(500).json({ status: "error", message: (err as Error).message }); }
});

app.post("/github/sync/:owner/:repo", async (req, res) => {
  try { res.json({ status: "success", data: await githubTool.syncRepoContext(req.params.owner, req.params.repo) }); }
  catch (err) { res.status(500).json({ status: "error", message: (err as Error).message }); }
});

app.post("/github/branch/:owner/:repo", async (req, res) => {
  const { name, base } = req.body;
  if (!name) return res.status(400).json({ status: "error", message: "branch name required" });
  try { res.json({ status: "success", data: await githubTool.createBranch(req.params.owner, req.params.repo, name, base) }); }
  catch (err) { res.status(500).json({ status: "error", message: (err as Error).message }); }
});

app.put("/github/commit/:owner/:repo", async (req, res) => {
  const { branch, path, content, message, sha } = req.body;
  if (!branch || !path || content === undefined || !message)
    return res.status(400).json({ status: "error", message: "branch, path, content, message required" });
  try { res.json({ status: "success", data: await githubTool.commitFile(req.params.owner, req.params.repo, branch, path, content, message, sha) }); }
  catch (err) { res.status(500).json({ status: "error", message: (err as Error).message }); }
});

app.post("/github/pr/:owner/:repo", async (req, res) => {
  const { head, title, body: prBody, base } = req.body;
  if (!head || !title) return res.status(400).json({ status: "error", message: "head and title required" });
  try {
    const pr = await githubTool.createPR(req.params.owner, req.params.repo, head, title, prBody ?? "", base);
    try { await githubTool.requestReview(req.params.owner, req.params.repo, pr.number); }
    catch { /* copilot review best-effort */ }
    res.json({ status: "success", data: pr });
  } catch (err) { res.status(500).json({ status: "error", message: (err as Error).message }); }
});

app.put("/github/merge/:owner/:repo/:prNumber", async (req, res) => {
  try {
    const prNumber = parseInt(req.params.prNumber, 10);
    const method = (req.body?.method as "squash" | "merge" | "rebase") ?? "squash";
    const result = await githubTool.mergePR(req.params.owner, req.params.repo, prNumber, method);
    if (req.body?.branch) {
      try { await githubTool.deleteBranch(req.params.owner, req.params.repo, req.body.branch); } catch { /* best-effort */ }
    }
    res.json({ status: "success", data: result });
  } catch (err) { res.status(500).json({ status: "error", message: (err as Error).message }); }
});

// ── KPI Dashboard ──

app.get("/kpi", (_req, res) => {
  res.json({ status: "success", data: getKPIDashboard() });
});

app.get("/kpi/history", (req, res) => {
  const limit = Number(req.query.limit ?? 20);
  res.json({ status: "success", data: getCycleHistory(limit) });
});

app.delete("/kpi", async (_req, res) => {
  await resetKPIs();
  res.json({ status: "success", data: { cleared: true } });
});

// ── Self-Healer ──

app.get("/healer/stats", (_req, res) => {
  res.json({ status: "success", data: getHealerStats() });
});

app.get("/healer/issues", (req, res) => {
  const limit = Number(req.query.limit ?? 50);
  res.json({ status: "success", data: getIssues(limit) });
});

app.get("/healer/providers", (_req, res) => {
  res.json({ status: "success", data: getProviderHealth() });
});

app.get("/healer/services", (_req, res) => {
  res.json({ status: "success", data: getServiceStates() });
});

// ── Startup ──

// Self-heal: resolve port conflicts and run checks BEFORE binding
await runStartupChecks(config.port);

// Initialize KPI tracker (loads history from SQLite)
await initKPITracker();

startKnowledgeWatcher();

// Auto-start knowledge fetch timer
if (config.knowledgeFetchEnabled) {
  const fetchIntervalMs = config.knowledgeFetchIntervalMs;
  console.log(`[startup] knowledge fetch timer: ${fetchIntervalMs / 60000}min interval`);
  setInterval(async () => {
    try {
      console.log("[knowledge-fetch-timer] fetching sources...");
      const result = await fetchAllSources();
      if (result.fetched > 0) {
        console.log(`[knowledge-fetch-timer] ${result.fetched} files fetched, re-ingesting...`);
        await knowledgeIngester.ingest();
      }
    } catch (err) {
      console.warn(`[knowledge-fetch-timer] failed: ${(err as Error).message}`);
    }
  }, fetchIntervalMs);
}

// Auto-start agent loop if configured
if (config.agentLoopEnabled) {
  console.log("[startup] agent loop auto-start enabled");
  startAgentLoop(config.agentLoopIntervalMs);
}

// Resilient listen with auto-remediation on EADDRINUSE
function listenWithRetry(retries = 3, delay = 2000): void {
  const server = app.listen(config.port, () => {
    console.log(`Local DevOps AI Gateway listening on port ${config.port}`);
    console.log(`LLM Provider: ${config.llmProvider} (bedrock=${config.useBedrock}, openrouter=${config.useOpenRouter})`);
    console.log(`SSE stream at http://127.0.0.1:${config.port}/events`);
    console.log(`Agent at http://127.0.0.1:${config.port}/agent/state`);
    console.log(`Self-healer at http://127.0.0.1:${config.port}/healer/stats`);

    // Start runtime watchdog (checks for hung requests, re-enables circuit-broken providers)
    startWatchdog(30_000);
  });

  server.on("error", async (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE" && retries > 0) {
      console.log(`[self-healer] port ${config.port} in use, auto-remediating (${retries} retries left)...`);
      await logIssue("port-conflict", "warning",
        `Port ${config.port} EADDRINUSE on bind attempt`,
        `Auto-killing stale process and retrying (${retries} left)`,
        { port: config.port, retriesLeft: retries }, false);
      server.close();
      const freed = await resolvePortConflict(config.port);
      if (freed) {
        setTimeout(() => listenWithRetry(retries - 1, delay), delay);
      } else {
        console.error(`[self-healer] CRITICAL: cannot free port ${config.port} after remediation`);
      }
    } else {
      console.error(`[FATAL] Server error: ${err.message}`);
    }
  });
}

listenWithRetry();
