import { useEffect, useState, useRef, useCallback } from "react";
import { api, createEventSource } from "./api";

// ── Types ──

const toolOptions = ["git", "terraform", "kubernetes", "docker", "shell", "openclaw", "github"] as const;

type Approval = { id: string; task: { objective: string; type: string; tools: string[] }; createdAt: string };
type Schedule = { id: string; cron: string; task: { objective: string; type: string } };
type Memory = { id: string; title: string; details: string; tags?: string[]; source?: string; createdAt: string };
type KnowledgeStats = { root: string; watch: boolean; points: number; qdrantHealthy?: boolean };
type RepoInfo = { owner: string; name: string; default_branch: string; url: string; addedAt: string; lastSynced?: string };
type SyncResult = { synced: number; skipped: number };
type DiscoveredRepo = { name: string; default_branch: string; url: string };

type SystemMetrics = {
  gateway: { uptime: number; sseClients: number };
  qdrant: { healthy: boolean; points: number; collections: string[] };
  ollama: { healthy: boolean; models: string[]; modelCount: number };
  knowledge: { root: string; watching: boolean; points: number };
  memories: { count: number };
  timestamp: string;
};
type RoadmapItem = {
  id: string; title: string; description: string;
  priority: "critical" | "high" | "medium" | "low";
  status: "planned" | "in-progress" | "done" | "blocked";
  repo: string;
  tasks: GeneratedTask[];
};

type GeneratedTask = {
  id: string; title: string; objective: string;
  type: string; tools: string[]; reasoning: string;
  estimatedComplexity: string; dependencies: string[];
};

type AgentState = {
  lastRun: string | null; running: boolean;
  roadmapItems: RoadmapItem[]; generatedTasks: GeneratedTask[];
  errors: string[];
};

type EventLog = { type: string; data: unknown; timestamp: string };

const initialTask = {
  type: "plan", objective: "", tools: [] as string[],
  contextPaths: "", approvalRequired: true, dryRun: true,
};
const priorityColor: Record<string, string> = {
  critical: "#dc2626", high: "#f59e0b", medium: "#6366f1", low: "#9ca3af",
};
const statusIcon: Record<string, string> = {
  planned: "○", "in-progress": "◐", done: "●", blocked: "✕",
};

function formatUptime(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// ── Status Dot ──
function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span style={{
      display: "inline-block", width: 10, height: 10, borderRadius: "50%",
      background: ok ? "#22c55e" : "#ef4444", marginRight: 6,
      boxShadow: ok ? "0 0 6px #22c55e" : "0 0 6px #ef4444",
    }} />
  );
}
// ── Main App ──

export default function App() {
  // Core state
  const [taskForm, setTaskForm] = useState(initialTask);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [knowledge, setKnowledge] = useState<KnowledgeStats | null>(null);
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [syncingRepo, setSyncingRepo] = useState<string | null>(null);
  const [syncResult, setSyncResult] = useState<Record<string, SyncResult>>({});
  const [addRepoInput, setAddRepoInput] = useState("");
  const [discoverOwner, setDiscoverOwner] = useState("");
  const [discoveredRepos, setDiscoveredRepos] = useState<DiscoveredRepo[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [taskMessage, setTaskMessage] = useState<string | null>(null);
  const [knowledgeLoading, setKnowledgeLoading] = useState(false);
  const [knowledgeMessage, setKnowledgeMessage] = useState<string | null>(null);

  // Real-time state
  const [metrics, setMetrics] = useState<SystemMetrics | null>(null);
  const [agentState, setAgentState] = useState<AgentState | null>(null);
  const [agentRunning, setAgentRunning] = useState(false);
  const [eventLog, setEventLog] = useState<EventLog[]>([]);
  const [sseConnected, setSseConnected] = useState(false);
  const [activeTab, setActiveTab] = useState<"dashboard" | "tasks" | "agent" | "knowledge" | "home">("dashboard");
  // Home automation state
  const [homeAdapters, setHomeAdapters] = useState<Record<string, boolean>>({});
  const [homeDevices, setHomeDevices] = useState<any[]>([]);
  const [homeScenes, setHomeScenes] = useState<any[]>([]);
  const [homeLoading, setHomeLoading] = useState(false);
  const [homeMessage, setHomeMessage] = useState<string | null>(null);
  const [networkDevices, setNetworkDevices] = useState<any[]>([]);
  const [networkScanning, setNetworkScanning] = useState(false);
  const [authStatus, setAuthStatus] = useState<{ method: string; user?: string; avatar?: string; name?: string } | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const addEvent = useCallback((evt: EventLog) => {
    setEventLog((prev) => [evt, ...prev].slice(0, 50));
  }, []);

  // SSE connection
  useEffect(() => {
    const es = createEventSource();
    eventSourceRef.current = es;
    es.onopen = () => setSseConnected(true);
    es.onerror = () => setSseConnected(false);
    es.addEventListener("metrics", (e) => {
      try {
        const parsed = JSON.parse(e.data);
        setMetrics(parsed.data);
        addEvent({ type: "metrics", data: "System metrics updated", timestamp: parsed.timestamp });
      } catch { /* bad data */ }
    });
    for (const evtType of ["task:submitted", "task:completed", "task:failed",
      "ingest:progress", "ingest:complete", "orchestrator:roadmap", "orchestrator:task"]) {
      es.addEventListener(evtType, (e) => {
        try {
          const parsed = JSON.parse(e.data);
          addEvent({ type: evtType, data: parsed.data, timestamp: parsed.timestamp });
        } catch { /* bad data */ }
      });
    }
    return () => { es.close(); eventSourceRef.current = null; };
  }, [addEvent]);
  // Load initial data
  const loadData = useCallback(async () => {
    try {
      const [appData, schedData, memData, knowledgeData] = await Promise.all([
        api.listApprovals(), api.listSchedules(), api.listMemories(), api.getKnowledge(),
      ]);
      setApprovals(appData as Approval[]);
      setSchedules(schedData as Schedule[]);
      setMemories(memData as Memory[]);
      setKnowledge(knowledgeData as KnowledgeStats);
    } catch (err) { setError((err as Error).message); }
    api.githubRepos().then((d) => setRepos(d as RepoInfo[])).catch(() => {});
    api.getMetrics().then((d) => setMetrics(d as SystemMetrics)).catch(() => {});
    api.getAgentState().then((d) => setAgentState(d as AgentState)).catch(() => {});
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // Load home automation data
  const loadHome = useCallback(async () => {
    setHomeLoading(true);
    try {
      const [statusData, devData, sceneData, netData] = await Promise.all([
        api.homeStatus(), api.homeDevices(), api.homeScenes(), api.homeNetwork().catch(() => ({ devices: [] })),
      ]);
      setHomeAdapters((statusData as any).adapters ?? {});
      setHomeDevices((devData as any).devices ?? []);
      setHomeScenes((sceneData as any).scenes ?? []);
      setNetworkDevices((netData as any).devices ?? []);
    } catch (err) { setError((err as Error).message); }
    finally { setHomeLoading(false); }
  }, []);

  useEffect(() => { if (activeTab === "home") loadHome(); }, [activeTab, loadHome]);

  const toggleDevice = async (id: string, currentOn: boolean) => {
    try {
      await api.homeSetState(id, { on: !currentOn });
      setHomeMessage(`${!currentOn ? "On" : "Off"}: ${id}`);
      setTimeout(() => setHomeMessage(null), 2000);
      loadHome();
    } catch (err) { setError((err as Error).message); }
  };

  const setDeviceBrightness = async (id: string, brightness: number) => {
    try {
      await api.homeSetState(id, { brightness });
      loadHome();
    } catch (err) { setError((err as Error).message); }
  };

  const activateScene = async (id: string, name: string) => {
    try {
      await api.homeActivateScene(id);
      setHomeMessage(`Scene activated: ${name}`);
      setTimeout(() => setHomeMessage(null), 2000);
      loadHome();
    } catch (err) { setError((err as Error).message); }
  };

  const runNetworkScan = async (quick = false) => {
    try {
      setNetworkScanning(true);
      setHomeMessage(quick ? "Quick scan..." : "Full network scan (ARP sweep + port probe)...");
      const result = await api.homeNetworkScan(quick) as any;
      setNetworkDevices(result.hosts ?? []);
      setHomeMessage(`Scan complete: ${result.hosts?.filter((h: any) => h.online).length} hosts online (${result.duration}ms)`);
      setTimeout(() => setHomeMessage(null), 4000);
    } catch (err) { setError((err as Error).message); }
    finally { setNetworkScanning(false); }
  };

  // Load auth status + handle OAuth callback redirect
  useEffect(() => {
    api.getAuthStatus().then((d) => setAuthStatus(d as any)).catch(() => {});
    const params = new URLSearchParams(window.location.search);
    if (params.get("auth_success")) {
      api.getAuthStatus().then((d) => setAuthStatus(d as any)).catch(() => {});
      window.history.replaceState({}, "", "/");
    }
    if (params.get("auth_error")) {
      setError(`GitHub OAuth failed: ${params.get("auth_error")}`);
      window.history.replaceState({}, "", "/");
    }
  }, []);

  // Actions
  const submitTask = async () => {
    try {
      setTaskMessage("Submitting...");
      await api.createTask({
        type: taskForm.type, objective: taskForm.objective, tools: taskForm.tools,
        contextPaths: taskForm.contextPaths.split(",").map((s) => s.trim()).filter(Boolean),
        approvalRequired: taskForm.approvalRequired, dryRun: taskForm.dryRun,
      });
      setTaskMessage("Task submitted"); setTaskForm(initialTask); loadData();
    } catch (err) { setTaskMessage(null); setError((err as Error).message); }
  };
  const syncRepo = async (owner: string, name: string) => {
    const key = `${owner}/${name}`;
    try {
      setSyncingRepo(key);
      const result = (await api.githubSync(owner, name)) as SyncResult;
      setSyncResult((prev) => ({ ...prev, [key]: result }));
    } catch (err) { setError((err as Error).message); }
    finally { setSyncingRepo(null); }
  };

  const handleAddRepo = async () => {
    const parts = addRepoInput.trim().split("/");
    if (parts.length !== 2) { setError("Format: owner/repo"); return; }
    try {
      await api.githubAddRepo(parts[0], parts[1]);
      setAddRepoInput("");
      api.githubRepos().then((d) => setRepos(d as RepoInfo[])).catch(() => {});
    } catch (err) { setError((err as Error).message); }
  };

  const handleRemoveRepo = async (owner: string, name: string) => {
    try {
      await api.githubRemoveRepo(owner, name);
      setRepos((prev) => prev.filter((r) => !(r.owner === owner && r.name === name)));
    } catch (err) { setError((err as Error).message); }
  };

  const handleDiscover = async () => {
    if (!discoverOwner.trim()) return;
    try {
      setDiscovering(true);
      const repos = (await api.githubDiscover(discoverOwner.trim())) as DiscoveredRepo[];
      setDiscoveredRepos(repos);
    } catch (err) { setError((err as Error).message); }
    finally { setDiscovering(false); }
  };

  const triggerIngest = async () => {
    try {
      setKnowledgeLoading(true); setKnowledgeMessage("Re-ingesting...");
      await api.ingestKnowledge();
      const stats = (await api.getKnowledge()) as KnowledgeStats;
      setKnowledge(stats); setKnowledgeMessage("Done");
      setTimeout(() => setKnowledgeMessage(null), 3000);
    } catch (err) { setError((err as Error).message); }
    finally { setKnowledgeLoading(false); }
  };

  const triggerAgent = async () => {
    try {
      setAgentRunning(true);
      const result = (await api.runAgent()) as AgentState;
      setAgentState(result);
    } catch (err) { setError((err as Error).message); }
    finally { setAgentRunning(false); }
  };
  // ── Render ──
  return (
    <div className="app-shell">
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
        <div>
          <h1 style={{ margin: 0 }}>Local DevOps AI Console</h1>
          <p style={{ margin: "0.25rem 0 0", color: "#6b7280", fontSize: "0.9rem" }}>
            Real-time orchestration · RAG knowledge · Autonomous agent
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <StatusDot ok={sseConnected} />
          <span style={{ fontSize: "0.8rem", color: "#6b7280" }}>
            {sseConnected ? "Live" : "Disconnected"}
          </span>
          {metrics && (
            <span style={{ fontSize: "0.8rem", color: "#6b7280" }}>
              · Up {formatUptime(metrics.gateway.uptime)}
            </span>
          )}
          <span style={{ borderLeft: "1px solid #d1d5db", height: 20 }} />
          {authStatus?.method === "oauth" && authStatus.user ? (
            <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
              {authStatus.avatar && <img src={authStatus.avatar} alt="" style={{ width: 22, height: 22, borderRadius: "50%" }} />}
              <span style={{ fontSize: "0.8rem", fontWeight: 600 }}>{authStatus.user}</span>
              <button onClick={async () => { await api.logout(); setAuthStatus({ method: "none" }); }}
                style={{ fontSize: "0.7rem", padding: "0.15rem 0.4rem", background: "#e5e7eb", borderRadius: 4, border: "none", cursor: "pointer" }}>
                Logout
              </button>
            </div>
          ) : authStatus?.method === "pat" ? (
            <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
              <span style={{ fontSize: "0.8rem", color: "#6b7280" }}>PAT</span>
              <button onClick={async () => {
                const d = (await api.getAuthUrl()) as { url: string };
                window.location.href = d.url;
              }} style={{ fontSize: "0.7rem", padding: "0.15rem 0.5rem", background: "#24292f", color: "#fff", borderRadius: 4, border: "none", cursor: "pointer" }}>
                GitHub Login
              </button>
            </div>
          ) : (
            <button onClick={async () => {
              const d = (await api.getAuthUrl()) as { url: string };
              window.location.href = d.url;
            }} style={{ fontSize: "0.8rem", padding: "0.3rem 0.7rem", background: "#24292f", color: "#fff", borderRadius: 6, border: "none", cursor: "pointer" }}>
              Connect GitHub
            </button>
          )}
        </div>
      </header>
      {error && (
        <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: "0.75rem", marginBottom: "1rem", color: "#dc2626" }}>
          {error}
          <button onClick={() => setError(null)} style={{ marginLeft: 8, background: "none", color: "#dc2626", textDecoration: "underline", border: "none", cursor: "pointer" }}>dismiss</button>
        </div>
      )}
      {/* Tab bar */}
      <div style={{ display: "flex", gap: "0.25rem", marginBottom: "1.5rem", borderBottom: "2px solid #e5e7eb", paddingBottom: "0.5rem" }}>
        {(["dashboard", "tasks", "agent", "knowledge", "home"] as const).map((tab) => (
          <button key={tab} onClick={() => setActiveTab(tab)}
            style={{
              padding: "0.5rem 1.25rem", borderRadius: "8px 8px 0 0", fontWeight: 600,
              background: activeTab === tab ? "#6366f1" : "transparent",
              color: activeTab === tab ? "#fff" : "#6b7280",
              border: "none", cursor: "pointer", fontSize: "0.9rem",
            }}>
            {tab === "dashboard" ? "Dashboard" : tab === "tasks" ? "Tasks & Approvals" : tab === "agent" ? "AI Agent" : tab === "knowledge" ? "Knowledge & GitHub" : "Home"}
          </button>
        ))}
      </div>

      {/* ═══ DASHBOARD TAB ═══ */}
      {activeTab === "dashboard" && (
        <>
          {/* Service health cards */}
          <div className="grid" style={{ marginBottom: "1.5rem" }}>
            <div className="card">
              <h2 style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <StatusDot ok={!!metrics?.gateway} /> Gateway
              </h2>
              <p>Port: 4123</p>
              {metrics && <>
                <p>Uptime: <strong>{formatUptime(metrics.gateway.uptime)}</strong></p>
                <p>SSE Clients: <strong>{metrics.gateway.sseClients}</strong></p>
              </>}
            </div>
            <div className="card">
              <h2 style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <StatusDot ok={!!metrics?.qdrant.healthy} /> Qdrant
              </h2>
              <p>Port: 6333</p>
              {metrics && <>
                <p>Vectors: <strong>{metrics.qdrant.points.toLocaleString()}</strong></p>
                <p>Collections: <strong>{metrics.qdrant.collections.join(", ") || "none"}</strong></p>
              </>}
            </div>

            <div className="card">
              <h2 style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <StatusDot ok={!!metrics?.ollama.healthy} /> Ollama
              </h2>
              <p>Port: 11434</p>
              {metrics && <>
                <p>Models: <strong>{metrics.ollama.modelCount}</strong></p>
                <div style={{ marginTop: "0.5rem" }}>
                  {metrics.ollama.models.map((m) => (
                    <span key={m} className="tag">{m.split(":")[0]}</span>
                  ))}
                </div>
              </>}
            </div>

            <div className="card">
              <h2>Memories</h2>
              {metrics && <p>Stored: <strong>{metrics.memories.count}</strong></p>}
              <p>Source: task-orchestrator, ui</p>
            </div>
          </div>
          {/* Event log */}
          <div className="card">
            <h2>Live Event Stream</h2>
            <div style={{ maxHeight: 260, overflow: "auto", fontFamily: "monospace", fontSize: "0.8rem" }}>
              {eventLog.length === 0 && <p style={{ color: "#9ca3af" }}>Waiting for events...</p>}
              {eventLog.map((evt, i) => (
                <div key={i} style={{ padding: "0.3rem 0", borderBottom: "1px solid #f3f4f6" }}>
                  <span style={{ color: "#6366f1", marginRight: 8 }}>{new Date(evt.timestamp).toLocaleTimeString()}</span>
                  <span style={{ color: "#374151", fontWeight: 600, marginRight: 8 }}>{evt.type}</span>
                  <span style={{ color: "#6b7280" }}>{typeof evt.data === "string" ? evt.data : JSON.stringify(evt.data)}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
      {/* ═══ TASKS TAB ═══ */}
      {activeTab === "tasks" && (
        <div className="grid" style={{ marginBottom: "1.5rem" }}>
          <div className="card">
            <h2>New Task</h2>
            <select value={taskForm.type} onChange={(e) => setTaskForm({ ...taskForm, type: e.target.value })}>
              <option value="plan">Plan</option>
              <option value="code">Code</option>
              <option value="diagnose">Diagnose</option>
              <option value="execute">Execute</option>
              <option value="review">Review</option>
            </select>
            <textarea placeholder="Objective" value={taskForm.objective}
              onChange={(e) => setTaskForm({ ...taskForm, objective: e.target.value })} />
            <label>Tools</label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", marginBottom: "0.75rem" }}>
              {toolOptions.map((tool) => (
                <label key={tool} style={{ fontSize: "0.85rem" }}>
                  <input type="checkbox" checked={taskForm.tools.includes(tool)}
                    onChange={(e) => {
                      const next = e.target.checked ? [...taskForm.tools, tool] : taskForm.tools.filter((t) => t !== tool);
                      setTaskForm({ ...taskForm, tools: next });
                    }} /> {tool}
                </label>
              ))}
            </div>
            <textarea placeholder="Context paths (comma separated)" value={taskForm.contextPaths}
              onChange={(e) => setTaskForm({ ...taskForm, contextPaths: e.target.value })} />            <label><input type="checkbox" checked={taskForm.approvalRequired}
              onChange={(e) => setTaskForm({ ...taskForm, approvalRequired: e.target.checked })} /> Require approval</label>
            <label><input type="checkbox" checked={taskForm.dryRun}
              onChange={(e) => setTaskForm({ ...taskForm, dryRun: e.target.checked })} /> Dry run</label>
            <button className="primary" onClick={submitTask} disabled={!taskForm.objective}>Submit Task</button>
            {taskMessage && <p>{taskMessage}</p>}
          </div>

          <div className="card">
            <h2>Approvals</h2>
            {approvals.length === 0 && <p style={{ color: "#9ca3af" }}>No pending approvals.</p>}
            <div className="list">
              {approvals.map((a) => (
                <div key={a.id} className="list-item">
                  <strong>{a.task.objective}</strong>
                  <p>Type: {a.task.type}</p>
                  <div>{a.task.tools.map((t) => <span className="tag" key={t}>{t}</span>)}</div>
                  <div style={{ marginTop: "0.5rem", display: "flex", gap: "0.5rem" }}>
                    <button className="primary" onClick={() => api.approve(a.id).then(loadData)}>Approve</button>
                    <button className="secondary" onClick={() => api.reject(a.id).then(loadData)}>Reject</button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <h2>Schedules</h2>
            <div className="list">
              {schedules.map((s) => (
                <div key={s.id} className="list-item">
                  <strong>{s.task.objective}</strong>
                  <p>{s.cron}</p>
                  <button className="secondary" onClick={() => api.deleteSchedule(s.id).then(loadData)}>Delete</button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      {/* ═══ AI AGENT TAB ═══ */}
      {activeTab === "agent" && (
        <>
          <div className="card" style={{ marginBottom: "1.5rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <h2 style={{ margin: 0 }}>Orchestrator Agent</h2>
                <p style={{ margin: "0.25rem 0 0", color: "#6b7280", fontSize: "0.85rem" }}>
                  Reads ROADMAP.md from GitHub repos, analyzes project context via RAG, auto-generates actionable tasks
                </p>
              </div>
              <button className="primary" onClick={triggerAgent} disabled={agentRunning}
                style={{ minWidth: 140 }}>
                {agentRunning ? "Analyzing..." : "Run Agent"}
              </button>
            </div>
            {agentState?.lastRun && (
              <p style={{ fontSize: "0.8rem", color: "#9ca3af", marginTop: "0.5rem" }}>
                Last run: {new Date(agentState.lastRun).toLocaleString()}
                {" · "}{agentState.roadmapItems.length} roadmap items
                {" · "}{agentState.generatedTasks.length} tasks generated
              </p>
            )}
            {agentState?.errors && agentState.errors.length > 0 && (
              <div style={{ marginTop: "0.5rem", padding: "0.5rem", background: "#fef2f2", borderRadius: 6, fontSize: "0.8rem", color: "#dc2626" }}>
                {agentState.errors.map((e, i) => <div key={i}>{e}</div>)}
              </div>
            )}
          </div>
          {/* Roadmap items */}
          {agentState?.roadmapItems && agentState.roadmapItems.length > 0 && (
            <div className="grid" style={{ marginBottom: "1.5rem" }}>
              {agentState.roadmapItems.map((item) => (
                <div key={item.id} className="card" style={{ borderLeft: `4px solid ${priorityColor[item.priority] ?? "#6366f1"}` }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                    <h3 style={{ margin: 0, fontSize: "1rem" }}>
                      <span style={{ marginRight: 6 }}>{statusIcon[item.status] ?? "○"}</span>
                      {item.title}
                    </h3>
                    <span className="tag" style={{ background: priorityColor[item.priority] + "22", color: priorityColor[item.priority] }}>
                      {item.priority}
                    </span>
                  </div>
                  <p style={{ fontSize: "0.85rem", color: "#6b7280", margin: "0.35rem 0" }}>{item.description}</p>
                  <p style={{ fontSize: "0.75rem", color: "#9ca3af" }}>
                    {item.repo} · {item.status} · {item.tasks.length} tasks
                  </p>

                  {item.tasks.length > 0 && (
                    <div style={{ marginTop: "0.75rem", borderTop: "1px solid #e5e7eb", paddingTop: "0.5rem" }}>
                      {item.tasks.map((task) => (
                        <div key={task.id} style={{ padding: "0.4rem 0", borderBottom: "1px solid #f3f4f6" }}>
                          <div style={{ display: "flex", justifyContent: "space-between" }}>
                            <strong style={{ fontSize: "0.85rem" }}>{task.title}</strong>
                            <span className="tag">{task.type}</span>
                          </div>
                          <p style={{ fontSize: "0.8rem", color: "#6b7280", margin: "0.2rem 0" }}>{task.objective}</p>
                          <div style={{ fontSize: "0.75rem", color: "#9ca3af" }}>
                            Complexity: {task.estimatedComplexity}
                            {task.tools.length > 0 && <> · Tools: {task.tools.join(", ")}</>}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {(!agentState || agentState.roadmapItems.length === 0) && !agentRunning && (
            <div className="card" style={{ textAlign: "center", padding: "3rem", color: "#9ca3af" }}>
              <p style={{ fontSize: "1.1rem", marginBottom: "0.5rem" }}>No roadmap data yet</p>
              <p>Click "Run Agent" to scan GitHub repos for ROADMAP.md files and auto-generate tasks</p>
            </div>
          )}
        </>
      )}
      {/* ═══ KNOWLEDGE TAB ═══ */}
      {activeTab === "knowledge" && (
        <>
          <div className="grid" style={{ marginBottom: "1.5rem" }}>
            <div className="card">
              <h2>Knowledge Store</h2>
              {knowledge ? (
                <>
                  <p><strong>Root:</strong> {knowledge.root}</p>
                  <p><strong>Embeddings:</strong> {knowledge.points.toLocaleString()} vectors</p>
                  <p><strong>Watcher:</strong> {knowledge.watch ? "auto-refresh ON" : "manual"}</p>
                  <p><strong>Qdrant:</strong> {knowledge.qdrantHealthy === false ? "unreachable" : "ready"}</p>
                  <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem" }}>
                    <button className="secondary" onClick={() => api.getKnowledge().then((d) => setKnowledge(d as KnowledgeStats))} disabled={knowledgeLoading}>
                      Refresh stats
                    </button>
                    <button className="primary" onClick={triggerIngest} disabled={knowledgeLoading}>
                      {knowledgeLoading ? "Ingesting..." : "Re-ingest now"}
                    </button>
                  </div>
                  {knowledgeMessage && <p>{knowledgeMessage}</p>}
                </>
              ) : <p>Loading knowledge stats...</p>}
            </div>

            <div className="card">
              <h2>GitHub Connector</h2>
              {/* Add repo */}
              <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.75rem" }}>
                <input placeholder="owner/repo" value={addRepoInput}
                  onChange={(e) => setAddRepoInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleAddRepo()}
                  style={{ flex: 1, marginBottom: 0 }} />
                <button className="primary" onClick={handleAddRepo} disabled={!addRepoInput.trim()}>Add</button>
              </div>
              {/* Discover repos from org/user */}
              <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.75rem" }}>
                <input placeholder="Discover org/user repos..." value={discoverOwner}
                  onChange={(e) => setDiscoverOwner(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleDiscover()}
                  style={{ flex: 1, marginBottom: 0 }} />
                <button className="secondary" onClick={handleDiscover} disabled={discovering || !discoverOwner.trim()}>
                  {discovering ? "..." : "Discover"}
                </button>
              </div>
              {discoveredRepos.length > 0 && (
                <div style={{ marginBottom: "0.75rem", maxHeight: 150, overflow: "auto", border: "1px solid #e5e7eb", borderRadius: 8, padding: "0.5rem" }}>
                  {discoveredRepos.map((dr) => (
                    <div key={dr.name} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0.25rem 0", borderBottom: "1px solid #f3f4f6" }}>
                      <span style={{ fontSize: "0.85rem" }}>{dr.name}</span>
                      <button className="primary" style={{ padding: "0.2rem 0.6rem", fontSize: "0.75rem" }}
                        onClick={async () => {
                          await api.githubAddRepo(discoverOwner.trim(), dr.name);
                          api.githubRepos().then((d) => setRepos(d as RepoInfo[])).catch(() => {});
                        }}>+ Add</button>
                    </div>
                  ))}
                </div>
              )}
              {/* Connected repos */}
              <div className="list">
                {repos.map((repo) => {
                  const key = `${repo.owner}/${repo.name}`;
                  return (
                    <div key={key} className="list-item">
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <div>
                          <strong>{repo.owner}/{repo.name}</strong>
                          <p style={{ margin: "0.25rem 0", fontSize: "0.85rem", color: "#6b7280" }}>
                            Branch: {repo.default_branch}
                            {repo.url && <> · <a href={repo.url} target="_blank" rel="noreferrer" style={{ color: "#6366f1" }}>GitHub</a></>}
                            {repo.lastSynced && <> · Synced {new Date(repo.lastSynced).toLocaleDateString()}</>}
                          </p>
                        </div>
                        <div style={{ display: "flex", gap: "0.35rem" }}>
                          <button className="primary" disabled={syncingRepo === key} onClick={() => syncRepo(repo.owner, repo.name)}
                            style={{ fontSize: "0.8rem", padding: "0.35rem 0.7rem" }}>
                            {syncingRepo === key ? "..." : "Sync"}
                          </button>
                          <button className="secondary" onClick={() => handleRemoveRepo(repo.owner, repo.name)}
                            style={{ fontSize: "0.8rem", padding: "0.35rem 0.7rem", color: "#dc2626" }}>✕</button>
                        </div>
                      </div>
                      {syncResult[key] && (
                        <p style={{ fontSize: "0.8rem", marginTop: "0.25rem", color: "#059669" }}>
                          Synced {syncResult[key].synced} files ({syncResult[key].skipped} skipped)
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
          {/* Memories */}
          <div className="card">
            <h2>Memories ({memories.length})</h2>
            <div className="list" style={{ maxHeight: 400, overflow: "auto" }}>
              {memories.map((memory) => (
                <div key={memory.id} className="list-item">
                  <strong>{memory.title}</strong>
                  <p style={{ whiteSpace: "pre-line", fontSize: "0.85rem" }}>{memory.details}</p>
                  <small>{new Date(memory.createdAt).toLocaleString()}</small>
                  {memory.tags && (
                    <div style={{ marginTop: "0.35rem" }}>
                      {memory.tags.map((tag) => <span key={tag} className="tag">{tag}</span>)}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </>
      )}
      {/* HOME AUTOMATION TAB */}
      {activeTab === "home" && (
        <>
          {/* Adapter status + controls */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
            <div>
              <h2 style={{ margin: 0 }}>Home Automation</h2>
              <div style={{ display: "flex", gap: "0.75rem", marginTop: "0.5rem" }}>
                {Object.entries(homeAdapters).map(([name, ok]) => (
                  <span key={name} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: "0.85rem" }}>
                    <StatusDot ok={ok} /> {name}
                  </span>
                ))}
              </div>
            </div>
            <button className="secondary" onClick={loadHome} disabled={homeLoading}>
              {homeLoading ? "Loading..." : "Refresh"}
            </button>
          </div>
          {homeMessage && (
            <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 8, padding: "0.5rem 0.75rem", marginBottom: "1rem", color: "#16a34a", fontSize: "0.85rem" }}>
              {homeMessage}
            </div>
          )}

          {/* Devices by room */}
          <div className="grid" style={{ marginBottom: "1.5rem" }}>
            {(() => {
              const rooms = new Map<string, any[]>();
              for (const d of homeDevices) {
                const room = d.room ?? "Ungrouped";
                if (!rooms.has(room)) rooms.set(room, []);
                rooms.get(room)!.push(d);
              }
              return Array.from(rooms.entries()).map(([room, devices]) => (
                <div key={room} className="card">
                  <h3 style={{ margin: "0 0 0.75rem", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    {room}
                    <span style={{ fontSize: "0.75rem", color: "#9ca3af", fontWeight: 400 }}>
                      {devices.filter((d: any) => d.state?.on).length}/{devices.length} on
                    </span>
                  </h3>
                  {devices.map((dev: any) => (
                    <div key={dev.id} style={{
                      padding: "0.5rem 0", borderBottom: "1px solid #f3f4f6",
                      display: "flex", justifyContent: "space-between", alignItems: "center",
                    }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <span style={{
                            width: 8, height: 8, borderRadius: "50%", display: "inline-block",
                            background: dev.state?.on ? "#facc15" : "#374151",
                            boxShadow: dev.state?.on ? "0 0 8px #facc15" : "none",
                          }} />
                          <strong style={{ fontSize: "0.85rem" }}>{dev.name}</strong>
                          <span className="tag" style={{ fontSize: "0.7rem" }}>{dev.adapter}</span>
                        </div>
                        {dev.state?.brightness != null && (
                          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
                            <input type="range" min={1} max={100}
                              value={dev.state.brightness}
                              onChange={(e) => setDeviceBrightness(dev.id, Number(e.target.value))}
                              style={{ width: 100, height: 4 }} />
                            <span style={{ fontSize: "0.75rem", color: "#6b7280" }}>{dev.state.brightness}%</span>
                          </div>
                        )}
                      </div>
                      <button
                        onClick={() => toggleDevice(dev.id, dev.state?.on ?? false)}
                        style={{
                          padding: "0.3rem 0.7rem", borderRadius: 6, border: "none", cursor: "pointer",
                          fontWeight: 600, fontSize: "0.8rem",
                          background: dev.state?.on ? "#fef3c7" : "#e5e7eb",
                          color: dev.state?.on ? "#92400e" : "#374151",
                        }}>
                        {dev.state?.on ? "ON" : "OFF"}
                      </button>
                    </div>
                  ))}
                </div>
              ));
            })()}
          </div>

          {/* Scenes */}
          {homeScenes.length > 0 && (
            <div className="card">
              <h3 style={{ margin: "0 0 0.75rem" }}>Scenes ({homeScenes.length})</h3>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
                {homeScenes.map((scene: any) => (
                  <button key={scene.id} onClick={() => activateScene(scene.id, scene.name)}
                    style={{
                      padding: "0.4rem 0.8rem", borderRadius: 8, border: "1px solid #e5e7eb",
                      background: "#fafafa", cursor: "pointer", fontSize: "0.8rem",
                    }}>
                    {scene.name}
                    {scene.room && <span style={{ color: "#9ca3af", marginLeft: 4, fontSize: "0.7rem" }}>{scene.room}</span>}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Network Devices */}
          <div className="card" style={{ marginTop: "1.5rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.75rem" }}>
              <h3 style={{ margin: 0 }}>
                Network Devices
                <span style={{ fontSize: "0.8rem", color: "#9ca3af", fontWeight: 400, marginLeft: 8 }}>
                  {networkDevices.filter((d: any) => d.online).length} online / {networkDevices.length} total
                </span>
              </h3>
              <div style={{ display: "flex", gap: "0.4rem" }}>
                <button className="secondary" onClick={() => runNetworkScan(true)} disabled={networkScanning}
                  style={{ fontSize: "0.8rem", padding: "0.3rem 0.6rem" }}>
                  Quick Scan
                </button>
                <button className="primary" onClick={() => runNetworkScan(false)} disabled={networkScanning}
                  style={{ fontSize: "0.8rem", padding: "0.3rem 0.6rem" }}>
                  {networkScanning ? "Scanning..." : "Full Scan"}
                </button>
              </div>
            </div>
            <div style={{ maxHeight: 400, overflow: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8rem" }}>
                <thead>
                  <tr style={{ borderBottom: "2px solid #e5e7eb", textAlign: "left" }}>
                    <th style={{ padding: "0.4rem" }}>Status</th>
                    <th style={{ padding: "0.4rem" }}>IP</th>
                    <th style={{ padding: "0.4rem" }}>Vendor</th>
                    <th style={{ padding: "0.4rem" }}>Type</th>
                    <th style={{ padding: "0.4rem" }}>Ports</th>
                    <th style={{ padding: "0.4rem" }}>Tags</th>
                    <th style={{ padding: "0.4rem" }}>Last Seen</th>
                  </tr>
                </thead>
                <tbody>
                  {networkDevices
                    .sort((a: any, b: any) => (b.online ? 1 : 0) - (a.online ? 1 : 0) || a.ip.localeCompare(b.ip, undefined, { numeric: true }))
                    .map((dev: any) => (
                    <tr key={dev.mac} style={{ borderBottom: "1px solid #f3f4f6", opacity: dev.online ? 1 : 0.5 }}>
                      <td style={{ padding: "0.4rem" }}>
                        <span style={{
                          width: 8, height: 8, borderRadius: "50%", display: "inline-block",
                          background: dev.online ? "#22c55e" : "#9ca3af",
                          boxShadow: dev.online ? "0 0 6px #22c55e" : "none",
                        }} />
                      </td>
                      <td style={{ padding: "0.4rem", fontFamily: "monospace" }}>{dev.ip}</td>
                      <td style={{ padding: "0.4rem" }}>{dev.vendor}</td>
                      <td style={{ padding: "0.4rem" }}>
                        <span className="tag">{dev.deviceType}</span>
                      </td>
                      <td style={{ padding: "0.4rem", fontFamily: "monospace", fontSize: "0.75rem" }}>
                        {dev.openPorts?.join(", ") || "—"}
                      </td>
                      <td style={{ padding: "0.4rem" }}>
                        {dev.tags?.map((t: string) => (
                          <span key={t} className="tag" style={{
                            fontSize: "0.65rem", marginRight: 3,
                            background: t.includes("govee") ? "#dcfce7" : t.includes("hue") ? "#fef3c7" : t.includes("alexa") ? "#dbeafe" : undefined,
                            color: t.includes("govee") ? "#16a34a" : t.includes("hue") ? "#92400e" : t.includes("alexa") ? "#2563eb" : undefined,
                          }}>{t}</span>
                        ))}
                      </td>
                      <td style={{ padding: "0.4rem", fontSize: "0.75rem", color: "#6b7280" }}>
                        {dev.lastSeen ? new Date(dev.lastSeen).toLocaleTimeString() : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {networkDevices.length === 0 && (
                <p style={{ textAlign: "center", color: "#9ca3af", padding: "1.5rem" }}>
                  No network data yet — click "Full Scan" to discover devices
                </p>
              )}
            </div>
          </div>

          {homeDevices.length === 0 && networkDevices.length === 0 && !homeLoading && (
            <div className="card" style={{ textAlign: "center", padding: "3rem", color: "#9ca3af" }}>
              <p style={{ fontSize: "1.1rem", marginBottom: "0.5rem" }}>No devices found</p>
              <p>Configure adapters in gateway/.env (HUE_BRIDGE_IP, GOVEE_API_KEY, IFTTT_WEBHOOK_KEY)</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}