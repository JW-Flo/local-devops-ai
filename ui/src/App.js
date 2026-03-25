import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useState, useRef, useCallback } from "react";
import { api, createEventSource } from "./api";
// ── Types ──
const toolOptions = ["git", "terraform", "kubernetes", "docker", "shell", "openclaw", "github"];
const initialTask = {
    type: "plan", objective: "", tools: [],
    contextPaths: "", approvalRequired: true, dryRun: true,
};
const priorityColor = {
    critical: "#dc2626", high: "#f59e0b", medium: "#6366f1", low: "#9ca3af",
};
const statusIcon = {
    planned: "○", "in-progress": "◐", done: "●", blocked: "✕",
};
function formatUptime(secs) {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}
// ── Status Dot ──
function StatusDot({ ok }) {
    return (_jsx("span", { style: {
            display: "inline-block", width: 10, height: 10, borderRadius: "50%",
            background: ok ? "#22c55e" : "#ef4444", marginRight: 6,
            boxShadow: ok ? "0 0 6px #22c55e" : "0 0 6px #ef4444",
        } }));
}
// ── Main App ──
export default function App() {
    // Core state
    const [taskForm, setTaskForm] = useState(initialTask);
    const [approvals, setApprovals] = useState([]);
    const [schedules, setSchedules] = useState([]);
    const [memories, setMemories] = useState([]);
    const [knowledge, setKnowledge] = useState(null);
    const [repos, setRepos] = useState([]);
    const [syncingRepo, setSyncingRepo] = useState(null);
    const [syncResult, setSyncResult] = useState({});
    const [addRepoInput, setAddRepoInput] = useState("");
    const [discoverOwner, setDiscoverOwner] = useState("");
    const [discoveredRepos, setDiscoveredRepos] = useState([]);
    const [discovering, setDiscovering] = useState(false);
    const [error, setError] = useState(null);
    const [taskMessage, setTaskMessage] = useState(null);
    const [knowledgeLoading, setKnowledgeLoading] = useState(false);
    const [knowledgeMessage, setKnowledgeMessage] = useState(null);
    // Real-time state
    const [metrics, setMetrics] = useState(null);
    const [agentState, setAgentState] = useState(null);
    const [agentRunning, setAgentRunning] = useState(false);
    const [eventLog, setEventLog] = useState([]);
    const [sseConnected, setSseConnected] = useState(false);
    const [activeTab, setActiveTab] = useState("dashboard");
    // Home automation state
    const [homeAdapters, setHomeAdapters] = useState({});
    const [homeDevices, setHomeDevices] = useState([]);
    const [homeScenes, setHomeScenes] = useState([]);
    const [homeLoading, setHomeLoading] = useState(false);
    const [homeMessage, setHomeMessage] = useState(null);
    const [networkDevices, setNetworkDevices] = useState([]);
    const [networkScanning, setNetworkScanning] = useState(false);
    const [authStatus, setAuthStatus] = useState(null);
    const eventSourceRef = useRef(null);
    const addEvent = useCallback((evt) => {
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
            }
            catch { /* bad data */ }
        });
        for (const evtType of ["task:submitted", "task:completed", "task:failed",
            "ingest:progress", "ingest:complete", "orchestrator:roadmap", "orchestrator:task"]) {
            es.addEventListener(evtType, (e) => {
                try {
                    const parsed = JSON.parse(e.data);
                    addEvent({ type: evtType, data: parsed.data, timestamp: parsed.timestamp });
                }
                catch { /* bad data */ }
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
            setApprovals(appData);
            setSchedules(schedData);
            setMemories(memData);
            setKnowledge(knowledgeData);
        }
        catch (err) {
            setError(err.message);
        }
        api.githubRepos().then((d) => setRepos(d)).catch(() => { });
        api.getMetrics().then((d) => setMetrics(d)).catch(() => { });
        api.getAgentState().then((d) => setAgentState(d)).catch(() => { });
    }, []);
    useEffect(() => { loadData(); }, [loadData]);
    // Load home automation data
    const loadHome = useCallback(async () => {
        setHomeLoading(true);
        try {
            const [statusData, devData, sceneData, netData] = await Promise.all([
                api.homeStatus(), api.homeDevices(), api.homeScenes(), api.homeNetwork().catch(() => ({ devices: [] })),
            ]);
            setHomeAdapters(statusData.adapters ?? {});
            setHomeDevices(devData.devices ?? []);
            setHomeScenes(sceneData.scenes ?? []);
            setNetworkDevices(netData.devices ?? []);
        }
        catch (err) {
            setError(err.message);
        }
        finally {
            setHomeLoading(false);
        }
    }, []);
    useEffect(() => { if (activeTab === "home")
        loadHome(); }, [activeTab, loadHome]);
    const toggleDevice = async (id, currentOn) => {
        try {
            await api.homeSetState(id, { on: !currentOn });
            setHomeMessage(`${!currentOn ? "On" : "Off"}: ${id}`);
            setTimeout(() => setHomeMessage(null), 2000);
            loadHome();
        }
        catch (err) {
            setError(err.message);
        }
    };
    const setDeviceBrightness = async (id, brightness) => {
        try {
            await api.homeSetState(id, { brightness });
            loadHome();
        }
        catch (err) {
            setError(err.message);
        }
    };
    const activateScene = async (id, name) => {
        try {
            await api.homeActivateScene(id);
            setHomeMessage(`Scene activated: ${name}`);
            setTimeout(() => setHomeMessage(null), 2000);
            loadHome();
        }
        catch (err) {
            setError(err.message);
        }
    };
    const runNetworkScan = async (quick = false) => {
        try {
            setNetworkScanning(true);
            setHomeMessage(quick ? "Quick scan..." : "Full network scan (ARP sweep + port probe)...");
            const result = await api.homeNetworkScan(quick);
            setNetworkDevices(result.hosts ?? []);
            setHomeMessage(`Scan complete: ${result.hosts?.filter((h) => h.online).length} hosts online (${result.duration}ms)`);
            setTimeout(() => setHomeMessage(null), 4000);
        }
        catch (err) {
            setError(err.message);
        }
        finally {
            setNetworkScanning(false);
        }
    };
    // Load auth status + handle OAuth callback redirect
    useEffect(() => {
        api.getAuthStatus().then((d) => setAuthStatus(d)).catch(() => { });
        const params = new URLSearchParams(window.location.search);
        if (params.get("auth_success")) {
            api.getAuthStatus().then((d) => setAuthStatus(d)).catch(() => { });
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
            setTaskMessage("Task submitted");
            setTaskForm(initialTask);
            loadData();
        }
        catch (err) {
            setTaskMessage(null);
            setError(err.message);
        }
    };
    const syncRepo = async (owner, name) => {
        const key = `${owner}/${name}`;
        try {
            setSyncingRepo(key);
            const result = (await api.githubSync(owner, name));
            setSyncResult((prev) => ({ ...prev, [key]: result }));
        }
        catch (err) {
            setError(err.message);
        }
        finally {
            setSyncingRepo(null);
        }
    };
    const handleAddRepo = async () => {
        const parts = addRepoInput.trim().split("/");
        if (parts.length !== 2) {
            setError("Format: owner/repo");
            return;
        }
        try {
            await api.githubAddRepo(parts[0], parts[1]);
            setAddRepoInput("");
            api.githubRepos().then((d) => setRepos(d)).catch(() => { });
        }
        catch (err) {
            setError(err.message);
        }
    };
    const handleRemoveRepo = async (owner, name) => {
        try {
            await api.githubRemoveRepo(owner, name);
            setRepos((prev) => prev.filter((r) => !(r.owner === owner && r.name === name)));
        }
        catch (err) {
            setError(err.message);
        }
    };
    const handleDiscover = async () => {
        if (!discoverOwner.trim())
            return;
        try {
            setDiscovering(true);
            const repos = (await api.githubDiscover(discoverOwner.trim()));
            setDiscoveredRepos(repos);
        }
        catch (err) {
            setError(err.message);
        }
        finally {
            setDiscovering(false);
        }
    };
    const triggerIngest = async () => {
        try {
            setKnowledgeLoading(true);
            setKnowledgeMessage("Re-ingesting...");
            await api.ingestKnowledge();
            const stats = (await api.getKnowledge());
            setKnowledge(stats);
            setKnowledgeMessage("Done");
            setTimeout(() => setKnowledgeMessage(null), 3000);
        }
        catch (err) {
            setError(err.message);
        }
        finally {
            setKnowledgeLoading(false);
        }
    };
    const triggerAgent = async () => {
        try {
            setAgentRunning(true);
            const result = (await api.runAgent());
            setAgentState(result);
        }
        catch (err) {
            setError(err.message);
        }
        finally {
            setAgentRunning(false);
        }
    };
    // ── Render ──
    return (_jsxs("div", { className: "app-shell", children: [_jsxs("header", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }, children: [_jsxs("div", { children: [_jsx("h1", { style: { margin: 0 }, children: "Local DevOps AI Console" }), _jsx("p", { style: { margin: "0.25rem 0 0", color: "#6b7280", fontSize: "0.9rem" }, children: "Real-time orchestration \u00B7 RAG knowledge \u00B7 Autonomous agent" })] }), _jsxs("div", { style: { display: "flex", alignItems: "center", gap: "0.75rem" }, children: [_jsx(StatusDot, { ok: sseConnected }), _jsx("span", { style: { fontSize: "0.8rem", color: "#6b7280" }, children: sseConnected ? "Live" : "Disconnected" }), metrics && (_jsxs("span", { style: { fontSize: "0.8rem", color: "#6b7280" }, children: ["\u00B7 Up ", formatUptime(metrics.gateway.uptime)] })), _jsx("span", { style: { borderLeft: "1px solid #d1d5db", height: 20 } }), authStatus?.method === "oauth" && authStatus.user ? (_jsxs("div", { style: { display: "flex", alignItems: "center", gap: "0.4rem" }, children: [authStatus.avatar && _jsx("img", { src: authStatus.avatar, alt: "", style: { width: 22, height: 22, borderRadius: "50%" } }), _jsx("span", { style: { fontSize: "0.8rem", fontWeight: 600 }, children: authStatus.user }), _jsx("button", { onClick: async () => { await api.logout(); setAuthStatus({ method: "none" }); }, style: { fontSize: "0.7rem", padding: "0.15rem 0.4rem", background: "#e5e7eb", borderRadius: 4, border: "none", cursor: "pointer" }, children: "Logout" })] })) : authStatus?.method === "pat" ? (_jsxs("div", { style: { display: "flex", alignItems: "center", gap: "0.4rem" }, children: [_jsx("span", { style: { fontSize: "0.8rem", color: "#6b7280" }, children: "PAT" }), _jsx("button", { onClick: async () => {
                                            const d = (await api.getAuthUrl());
                                            window.location.href = d.url;
                                        }, style: { fontSize: "0.7rem", padding: "0.15rem 0.5rem", background: "#24292f", color: "#fff", borderRadius: 4, border: "none", cursor: "pointer" }, children: "GitHub Login" })] })) : (_jsx("button", { onClick: async () => {
                                    const d = (await api.getAuthUrl());
                                    window.location.href = d.url;
                                }, style: { fontSize: "0.8rem", padding: "0.3rem 0.7rem", background: "#24292f", color: "#fff", borderRadius: 6, border: "none", cursor: "pointer" }, children: "Connect GitHub" }))] })] }), error && (_jsxs("div", { style: { background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: "0.75rem", marginBottom: "1rem", color: "#dc2626" }, children: [error, _jsx("button", { onClick: () => setError(null), style: { marginLeft: 8, background: "none", color: "#dc2626", textDecoration: "underline", border: "none", cursor: "pointer" }, children: "dismiss" })] })), _jsx("div", { style: { display: "flex", gap: "0.25rem", marginBottom: "1.5rem", borderBottom: "2px solid #e5e7eb", paddingBottom: "0.5rem" }, children: ["dashboard", "tasks", "agent", "knowledge", "home"].map((tab) => (_jsx("button", { onClick: () => setActiveTab(tab), style: {
                        padding: "0.5rem 1.25rem", borderRadius: "8px 8px 0 0", fontWeight: 600,
                        background: activeTab === tab ? "#6366f1" : "transparent",
                        color: activeTab === tab ? "#fff" : "#6b7280",
                        border: "none", cursor: "pointer", fontSize: "0.9rem",
                    }, children: tab === "dashboard" ? "Dashboard" : tab === "tasks" ? "Tasks & Approvals" : tab === "agent" ? "AI Agent" : tab === "knowledge" ? "Knowledge & GitHub" : "Home" }, tab))) }), activeTab === "dashboard" && (_jsxs(_Fragment, { children: [_jsxs("div", { className: "grid", style: { marginBottom: "1.5rem" }, children: [_jsxs("div", { className: "card", children: [_jsxs("h2", { style: { display: "flex", alignItems: "center", gap: 8 }, children: [_jsx(StatusDot, { ok: !!metrics?.gateway }), " Gateway"] }), _jsx("p", { children: "Port: 4123" }), metrics && _jsxs(_Fragment, { children: [_jsxs("p", { children: ["Uptime: ", _jsx("strong", { children: formatUptime(metrics.gateway.uptime) })] }), _jsxs("p", { children: ["SSE Clients: ", _jsx("strong", { children: metrics.gateway.sseClients })] })] })] }), _jsxs("div", { className: "card", children: [_jsxs("h2", { style: { display: "flex", alignItems: "center", gap: 8 }, children: [_jsx(StatusDot, { ok: !!metrics?.qdrant.healthy }), " Qdrant"] }), _jsx("p", { children: "Port: 6333" }), metrics && _jsxs(_Fragment, { children: [_jsxs("p", { children: ["Vectors: ", _jsx("strong", { children: metrics.qdrant.points.toLocaleString() })] }), _jsxs("p", { children: ["Collections: ", _jsx("strong", { children: metrics.qdrant.collections.join(", ") || "none" })] })] })] }), _jsxs("div", { className: "card", children: [_jsxs("h2", { style: { display: "flex", alignItems: "center", gap: 8 }, children: [_jsx(StatusDot, { ok: !!metrics?.ollama.healthy }), " Ollama"] }), _jsx("p", { children: "Port: 11434" }), metrics && _jsxs(_Fragment, { children: [_jsxs("p", { children: ["Models: ", _jsx("strong", { children: metrics.ollama.modelCount })] }), _jsx("div", { style: { marginTop: "0.5rem" }, children: metrics.ollama.models.map((m) => (_jsx("span", { className: "tag", children: m.split(":")[0] }, m))) })] })] }), _jsxs("div", { className: "card", children: [_jsx("h2", { children: "Memories" }), metrics && _jsxs("p", { children: ["Stored: ", _jsx("strong", { children: metrics.memories.count })] }), _jsx("p", { children: "Source: task-orchestrator, ui" })] })] }), _jsxs("div", { className: "card", children: [_jsx("h2", { children: "Live Event Stream" }), _jsxs("div", { style: { maxHeight: 260, overflow: "auto", fontFamily: "monospace", fontSize: "0.8rem" }, children: [eventLog.length === 0 && _jsx("p", { style: { color: "#9ca3af" }, children: "Waiting for events..." }), eventLog.map((evt, i) => (_jsxs("div", { style: { padding: "0.3rem 0", borderBottom: "1px solid #f3f4f6" }, children: [_jsx("span", { style: { color: "#6366f1", marginRight: 8 }, children: new Date(evt.timestamp).toLocaleTimeString() }), _jsx("span", { style: { color: "#374151", fontWeight: 600, marginRight: 8 }, children: evt.type }), _jsx("span", { style: { color: "#6b7280" }, children: typeof evt.data === "string" ? evt.data : JSON.stringify(evt.data) })] }, i)))] })] })] })), activeTab === "tasks" && (_jsxs("div", { className: "grid", style: { marginBottom: "1.5rem" }, children: [_jsxs("div", { className: "card", children: [_jsx("h2", { children: "New Task" }), _jsxs("select", { value: taskForm.type, onChange: (e) => setTaskForm({ ...taskForm, type: e.target.value }), children: [_jsx("option", { value: "plan", children: "Plan" }), _jsx("option", { value: "code", children: "Code" }), _jsx("option", { value: "diagnose", children: "Diagnose" }), _jsx("option", { value: "execute", children: "Execute" }), _jsx("option", { value: "review", children: "Review" })] }), _jsx("textarea", { placeholder: "Objective", value: taskForm.objective, onChange: (e) => setTaskForm({ ...taskForm, objective: e.target.value }) }), _jsx("label", { children: "Tools" }), _jsx("div", { style: { display: "flex", flexWrap: "wrap", gap: "0.5rem", marginBottom: "0.75rem" }, children: toolOptions.map((tool) => (_jsxs("label", { style: { fontSize: "0.85rem" }, children: [_jsx("input", { type: "checkbox", checked: taskForm.tools.includes(tool), onChange: (e) => {
                                                const next = e.target.checked ? [...taskForm.tools, tool] : taskForm.tools.filter((t) => t !== tool);
                                                setTaskForm({ ...taskForm, tools: next });
                                            } }), " ", tool] }, tool))) }), _jsx("textarea", { placeholder: "Context paths (comma separated)", value: taskForm.contextPaths, onChange: (e) => setTaskForm({ ...taskForm, contextPaths: e.target.value }) }), "            ", _jsxs("label", { children: [_jsx("input", { type: "checkbox", checked: taskForm.approvalRequired, onChange: (e) => setTaskForm({ ...taskForm, approvalRequired: e.target.checked }) }), " Require approval"] }), _jsxs("label", { children: [_jsx("input", { type: "checkbox", checked: taskForm.dryRun, onChange: (e) => setTaskForm({ ...taskForm, dryRun: e.target.checked }) }), " Dry run"] }), _jsx("button", { className: "primary", onClick: submitTask, disabled: !taskForm.objective, children: "Submit Task" }), taskMessage && _jsx("p", { children: taskMessage })] }), _jsxs("div", { className: "card", children: [_jsx("h2", { children: "Approvals" }), approvals.length === 0 && _jsx("p", { style: { color: "#9ca3af" }, children: "No pending approvals." }), _jsx("div", { className: "list", children: approvals.map((a) => (_jsxs("div", { className: "list-item", children: [_jsx("strong", { children: a.task.objective }), _jsxs("p", { children: ["Type: ", a.task.type] }), _jsx("div", { children: a.task.tools.map((t) => _jsx("span", { className: "tag", children: t }, t)) }), _jsxs("div", { style: { marginTop: "0.5rem", display: "flex", gap: "0.5rem" }, children: [_jsx("button", { className: "primary", onClick: () => api.approve(a.id).then(loadData), children: "Approve" }), _jsx("button", { className: "secondary", onClick: () => api.reject(a.id).then(loadData), children: "Reject" })] })] }, a.id))) })] }), _jsxs("div", { className: "card", children: [_jsx("h2", { children: "Schedules" }), _jsx("div", { className: "list", children: schedules.map((s) => (_jsxs("div", { className: "list-item", children: [_jsx("strong", { children: s.task.objective }), _jsx("p", { children: s.cron }), _jsx("button", { className: "secondary", onClick: () => api.deleteSchedule(s.id).then(loadData), children: "Delete" })] }, s.id))) })] })] })), activeTab === "agent" && (_jsxs(_Fragment, { children: [_jsxs("div", { className: "card", style: { marginBottom: "1.5rem" }, children: [_jsxs("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center" }, children: [_jsxs("div", { children: [_jsx("h2", { style: { margin: 0 }, children: "Orchestrator Agent" }), _jsx("p", { style: { margin: "0.25rem 0 0", color: "#6b7280", fontSize: "0.85rem" }, children: "Reads ROADMAP.md from GitHub repos, analyzes project context via RAG, auto-generates actionable tasks" })] }), _jsx("button", { className: "primary", onClick: triggerAgent, disabled: agentRunning, style: { minWidth: 140 }, children: agentRunning ? "Analyzing..." : "Run Agent" })] }), agentState?.lastRun && (_jsxs("p", { style: { fontSize: "0.8rem", color: "#9ca3af", marginTop: "0.5rem" }, children: ["Last run: ", new Date(agentState.lastRun).toLocaleString(), " · ", agentState.roadmapItems.length, " roadmap items", " · ", agentState.generatedTasks.length, " tasks generated"] })), agentState?.errors && agentState.errors.length > 0 && (_jsx("div", { style: { marginTop: "0.5rem", padding: "0.5rem", background: "#fef2f2", borderRadius: 6, fontSize: "0.8rem", color: "#dc2626" }, children: agentState.errors.map((e, i) => _jsx("div", { children: e }, i)) }))] }), agentState?.roadmapItems && agentState.roadmapItems.length > 0 && (_jsx("div", { className: "grid", style: { marginBottom: "1.5rem" }, children: agentState.roadmapItems.map((item) => (_jsxs("div", { className: "card", style: { borderLeft: `4px solid ${priorityColor[item.priority] ?? "#6366f1"}` }, children: [_jsxs("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "flex-start" }, children: [_jsxs("h3", { style: { margin: 0, fontSize: "1rem" }, children: [_jsx("span", { style: { marginRight: 6 }, children: statusIcon[item.status] ?? "○" }), item.title] }), _jsx("span", { className: "tag", style: { background: priorityColor[item.priority] + "22", color: priorityColor[item.priority] }, children: item.priority })] }), _jsx("p", { style: { fontSize: "0.85rem", color: "#6b7280", margin: "0.35rem 0" }, children: item.description }), _jsxs("p", { style: { fontSize: "0.75rem", color: "#9ca3af" }, children: [item.repo, " \u00B7 ", item.status, " \u00B7 ", item.tasks.length, " tasks"] }), item.tasks.length > 0 && (_jsx("div", { style: { marginTop: "0.75rem", borderTop: "1px solid #e5e7eb", paddingTop: "0.5rem" }, children: item.tasks.map((task) => (_jsxs("div", { style: { padding: "0.4rem 0", borderBottom: "1px solid #f3f4f6" }, children: [_jsxs("div", { style: { display: "flex", justifyContent: "space-between" }, children: [_jsx("strong", { style: { fontSize: "0.85rem" }, children: task.title }), _jsx("span", { className: "tag", children: task.type })] }), _jsx("p", { style: { fontSize: "0.8rem", color: "#6b7280", margin: "0.2rem 0" }, children: task.objective }), _jsxs("div", { style: { fontSize: "0.75rem", color: "#9ca3af" }, children: ["Complexity: ", task.estimatedComplexity, task.tools.length > 0 && _jsxs(_Fragment, { children: [" \u00B7 Tools: ", task.tools.join(", ")] })] })] }, task.id))) }))] }, item.id))) })), (!agentState || agentState.roadmapItems.length === 0) && !agentRunning && (_jsxs("div", { className: "card", style: { textAlign: "center", padding: "3rem", color: "#9ca3af" }, children: [_jsx("p", { style: { fontSize: "1.1rem", marginBottom: "0.5rem" }, children: "No roadmap data yet" }), _jsx("p", { children: "Click \"Run Agent\" to scan GitHub repos for ROADMAP.md files and auto-generate tasks" })] }))] })), activeTab === "knowledge" && (_jsxs(_Fragment, { children: [_jsxs("div", { className: "grid", style: { marginBottom: "1.5rem" }, children: [_jsxs("div", { className: "card", children: [_jsx("h2", { children: "Knowledge Store" }), knowledge ? (_jsxs(_Fragment, { children: [_jsxs("p", { children: [_jsx("strong", { children: "Root:" }), " ", knowledge.root] }), _jsxs("p", { children: [_jsx("strong", { children: "Embeddings:" }), " ", knowledge.points.toLocaleString(), " vectors"] }), _jsxs("p", { children: [_jsx("strong", { children: "Watcher:" }), " ", knowledge.watch ? "auto-refresh ON" : "manual"] }), _jsxs("p", { children: [_jsx("strong", { children: "Qdrant:" }), " ", knowledge.qdrantHealthy === false ? "unreachable" : "ready"] }), _jsxs("div", { style: { display: "flex", gap: "0.5rem", marginTop: "0.75rem" }, children: [_jsx("button", { className: "secondary", onClick: () => api.getKnowledge().then((d) => setKnowledge(d)), disabled: knowledgeLoading, children: "Refresh stats" }), _jsx("button", { className: "primary", onClick: triggerIngest, disabled: knowledgeLoading, children: knowledgeLoading ? "Ingesting..." : "Re-ingest now" })] }), knowledgeMessage && _jsx("p", { children: knowledgeMessage })] })) : _jsx("p", { children: "Loading knowledge stats..." })] }), _jsxs("div", { className: "card", children: [_jsx("h2", { children: "GitHub Connector" }), _jsxs("div", { style: { display: "flex", gap: "0.5rem", marginBottom: "0.75rem" }, children: [_jsx("input", { placeholder: "owner/repo", value: addRepoInput, onChange: (e) => setAddRepoInput(e.target.value), onKeyDown: (e) => e.key === "Enter" && handleAddRepo(), style: { flex: 1, marginBottom: 0 } }), _jsx("button", { className: "primary", onClick: handleAddRepo, disabled: !addRepoInput.trim(), children: "Add" })] }), _jsxs("div", { style: { display: "flex", gap: "0.5rem", marginBottom: "0.75rem" }, children: [_jsx("input", { placeholder: "Discover org/user repos...", value: discoverOwner, onChange: (e) => setDiscoverOwner(e.target.value), onKeyDown: (e) => e.key === "Enter" && handleDiscover(), style: { flex: 1, marginBottom: 0 } }), _jsx("button", { className: "secondary", onClick: handleDiscover, disabled: discovering || !discoverOwner.trim(), children: discovering ? "..." : "Discover" })] }), discoveredRepos.length > 0 && (_jsx("div", { style: { marginBottom: "0.75rem", maxHeight: 150, overflow: "auto", border: "1px solid #e5e7eb", borderRadius: 8, padding: "0.5rem" }, children: discoveredRepos.map((dr) => (_jsxs("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0.25rem 0", borderBottom: "1px solid #f3f4f6" }, children: [_jsx("span", { style: { fontSize: "0.85rem" }, children: dr.name }), _jsx("button", { className: "primary", style: { padding: "0.2rem 0.6rem", fontSize: "0.75rem" }, onClick: async () => {
                                                        await api.githubAddRepo(discoverOwner.trim(), dr.name);
                                                        api.githubRepos().then((d) => setRepos(d)).catch(() => { });
                                                    }, children: "+ Add" })] }, dr.name))) })), _jsx("div", { className: "list", children: repos.map((repo) => {
                                            const key = `${repo.owner}/${repo.name}`;
                                            return (_jsxs("div", { className: "list-item", children: [_jsxs("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center" }, children: [_jsxs("div", { children: [_jsxs("strong", { children: [repo.owner, "/", repo.name] }), _jsxs("p", { style: { margin: "0.25rem 0", fontSize: "0.85rem", color: "#6b7280" }, children: ["Branch: ", repo.default_branch, repo.url && _jsxs(_Fragment, { children: [" \u00B7 ", _jsx("a", { href: repo.url, target: "_blank", rel: "noreferrer", style: { color: "#6366f1" }, children: "GitHub" })] }), repo.lastSynced && _jsxs(_Fragment, { children: [" \u00B7 Synced ", new Date(repo.lastSynced).toLocaleDateString()] })] })] }), _jsxs("div", { style: { display: "flex", gap: "0.35rem" }, children: [_jsx("button", { className: "primary", disabled: syncingRepo === key, onClick: () => syncRepo(repo.owner, repo.name), style: { fontSize: "0.8rem", padding: "0.35rem 0.7rem" }, children: syncingRepo === key ? "..." : "Sync" }), _jsx("button", { className: "secondary", onClick: () => handleRemoveRepo(repo.owner, repo.name), style: { fontSize: "0.8rem", padding: "0.35rem 0.7rem", color: "#dc2626" }, children: "\u2715" })] })] }), syncResult[key] && (_jsxs("p", { style: { fontSize: "0.8rem", marginTop: "0.25rem", color: "#059669" }, children: ["Synced ", syncResult[key].synced, " files (", syncResult[key].skipped, " skipped)"] }))] }, key));
                                        }) })] })] }), _jsxs("div", { className: "card", children: [_jsxs("h2", { children: ["Memories (", memories.length, ")"] }), _jsx("div", { className: "list", style: { maxHeight: 400, overflow: "auto" }, children: memories.map((memory) => (_jsxs("div", { className: "list-item", children: [_jsx("strong", { children: memory.title }), _jsx("p", { style: { whiteSpace: "pre-line", fontSize: "0.85rem" }, children: memory.details }), _jsx("small", { children: new Date(memory.createdAt).toLocaleString() }), memory.tags && (_jsx("div", { style: { marginTop: "0.35rem" }, children: memory.tags.map((tag) => _jsx("span", { className: "tag", children: tag }, tag)) }))] }, memory.id))) })] })] })), activeTab === "home" && (_jsxs(_Fragment, { children: [_jsxs("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }, children: [_jsxs("div", { children: [_jsx("h2", { style: { margin: 0 }, children: "Home Automation" }), _jsx("div", { style: { display: "flex", gap: "0.75rem", marginTop: "0.5rem" }, children: Object.entries(homeAdapters).map(([name, ok]) => (_jsxs("span", { style: { display: "flex", alignItems: "center", gap: 4, fontSize: "0.85rem" }, children: [_jsx(StatusDot, { ok: ok }), " ", name] }, name))) })] }), _jsx("button", { className: "secondary", onClick: loadHome, disabled: homeLoading, children: homeLoading ? "Loading..." : "Refresh" })] }), homeMessage && (_jsx("div", { style: { background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 8, padding: "0.5rem 0.75rem", marginBottom: "1rem", color: "#16a34a", fontSize: "0.85rem" }, children: homeMessage })), _jsx("div", { className: "grid", style: { marginBottom: "1.5rem" }, children: (() => {
                            const rooms = new Map();
                            for (const d of homeDevices) {
                                const room = d.room ?? "Ungrouped";
                                if (!rooms.has(room))
                                    rooms.set(room, []);
                                rooms.get(room).push(d);
                            }
                            return Array.from(rooms.entries()).map(([room, devices]) => (_jsxs("div", { className: "card", children: [_jsxs("h3", { style: { margin: "0 0 0.75rem", display: "flex", justifyContent: "space-between", alignItems: "center" }, children: [room, _jsxs("span", { style: { fontSize: "0.75rem", color: "#9ca3af", fontWeight: 400 }, children: [devices.filter((d) => d.state?.on).length, "/", devices.length, " on"] })] }), devices.map((dev) => (_jsxs("div", { style: {
                                            padding: "0.5rem 0", borderBottom: "1px solid #f3f4f6",
                                            display: "flex", justifyContent: "space-between", alignItems: "center",
                                        }, children: [_jsxs("div", { style: { flex: 1 }, children: [_jsxs("div", { style: { display: "flex", alignItems: "center", gap: 6 }, children: [_jsx("span", { style: {
                                                                    width: 8, height: 8, borderRadius: "50%", display: "inline-block",
                                                                    background: dev.state?.on ? "#facc15" : "#374151",
                                                                    boxShadow: dev.state?.on ? "0 0 8px #facc15" : "none",
                                                                } }), _jsx("strong", { style: { fontSize: "0.85rem" }, children: dev.name }), _jsx("span", { className: "tag", style: { fontSize: "0.7rem" }, children: dev.adapter })] }), dev.state?.brightness != null && (_jsxs("div", { style: { display: "flex", alignItems: "center", gap: 6, marginTop: 4 }, children: [_jsx("input", { type: "range", min: 1, max: 100, value: dev.state.brightness, onChange: (e) => setDeviceBrightness(dev.id, Number(e.target.value)), style: { width: 100, height: 4 } }), _jsxs("span", { style: { fontSize: "0.75rem", color: "#6b7280" }, children: [dev.state.brightness, "%"] })] }))] }), _jsx("button", { onClick: () => toggleDevice(dev.id, dev.state?.on ?? false), style: {
                                                    padding: "0.3rem 0.7rem", borderRadius: 6, border: "none", cursor: "pointer",
                                                    fontWeight: 600, fontSize: "0.8rem",
                                                    background: dev.state?.on ? "#fef3c7" : "#e5e7eb",
                                                    color: dev.state?.on ? "#92400e" : "#374151",
                                                }, children: dev.state?.on ? "ON" : "OFF" })] }, dev.id)))] }, room)));
                        })() }), homeScenes.length > 0 && (_jsxs("div", { className: "card", children: [_jsxs("h3", { style: { margin: "0 0 0.75rem" }, children: ["Scenes (", homeScenes.length, ")"] }), _jsx("div", { style: { display: "flex", flexWrap: "wrap", gap: "0.5rem" }, children: homeScenes.map((scene) => (_jsxs("button", { onClick: () => activateScene(scene.id, scene.name), style: {
                                        padding: "0.4rem 0.8rem", borderRadius: 8, border: "1px solid #e5e7eb",
                                        background: "#fafafa", cursor: "pointer", fontSize: "0.8rem",
                                    }, children: [scene.name, scene.room && _jsx("span", { style: { color: "#9ca3af", marginLeft: 4, fontSize: "0.7rem" }, children: scene.room })] }, scene.id))) })] })), _jsxs("div", { className: "card", style: { marginTop: "1.5rem" }, children: [_jsxs("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.75rem" }, children: [_jsxs("h3", { style: { margin: 0 }, children: ["Network Devices", _jsxs("span", { style: { fontSize: "0.8rem", color: "#9ca3af", fontWeight: 400, marginLeft: 8 }, children: [networkDevices.filter((d) => d.online).length, " online / ", networkDevices.length, " total"] })] }), _jsxs("div", { style: { display: "flex", gap: "0.4rem" }, children: [_jsx("button", { className: "secondary", onClick: () => runNetworkScan(true), disabled: networkScanning, style: { fontSize: "0.8rem", padding: "0.3rem 0.6rem" }, children: "Quick Scan" }), _jsx("button", { className: "primary", onClick: () => runNetworkScan(false), disabled: networkScanning, style: { fontSize: "0.8rem", padding: "0.3rem 0.6rem" }, children: networkScanning ? "Scanning..." : "Full Scan" })] })] }), _jsxs("div", { style: { maxHeight: 400, overflow: "auto" }, children: [_jsxs("table", { style: { width: "100%", borderCollapse: "collapse", fontSize: "0.8rem" }, children: [_jsx("thead", { children: _jsxs("tr", { style: { borderBottom: "2px solid #e5e7eb", textAlign: "left" }, children: [_jsx("th", { style: { padding: "0.4rem" }, children: "Status" }), _jsx("th", { style: { padding: "0.4rem" }, children: "IP" }), _jsx("th", { style: { padding: "0.4rem" }, children: "Vendor" }), _jsx("th", { style: { padding: "0.4rem" }, children: "Type" }), _jsx("th", { style: { padding: "0.4rem" }, children: "Ports" }), _jsx("th", { style: { padding: "0.4rem" }, children: "Tags" }), _jsx("th", { style: { padding: "0.4rem" }, children: "Last Seen" })] }) }), _jsx("tbody", { children: networkDevices
                                                    .sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0) || a.ip.localeCompare(b.ip, undefined, { numeric: true }))
                                                    .map((dev) => (_jsxs("tr", { style: { borderBottom: "1px solid #f3f4f6", opacity: dev.online ? 1 : 0.5 }, children: [_jsx("td", { style: { padding: "0.4rem" }, children: _jsx("span", { style: {
                                                                    width: 8, height: 8, borderRadius: "50%", display: "inline-block",
                                                                    background: dev.online ? "#22c55e" : "#9ca3af",
                                                                    boxShadow: dev.online ? "0 0 6px #22c55e" : "none",
                                                                } }) }), _jsx("td", { style: { padding: "0.4rem", fontFamily: "monospace" }, children: dev.ip }), _jsx("td", { style: { padding: "0.4rem" }, children: dev.vendor }), _jsx("td", { style: { padding: "0.4rem" }, children: _jsx("span", { className: "tag", children: dev.deviceType }) }), _jsx("td", { style: { padding: "0.4rem", fontFamily: "monospace", fontSize: "0.75rem" }, children: dev.openPorts?.join(", ") || "—" }), _jsx("td", { style: { padding: "0.4rem" }, children: dev.tags?.map((t) => (_jsx("span", { className: "tag", style: {
                                                                    fontSize: "0.65rem", marginRight: 3,
                                                                    background: t.includes("govee") ? "#dcfce7" : t.includes("hue") ? "#fef3c7" : t.includes("alexa") ? "#dbeafe" : undefined,
                                                                    color: t.includes("govee") ? "#16a34a" : t.includes("hue") ? "#92400e" : t.includes("alexa") ? "#2563eb" : undefined,
                                                                }, children: t }, t))) }), _jsx("td", { style: { padding: "0.4rem", fontSize: "0.75rem", color: "#6b7280" }, children: dev.lastSeen ? new Date(dev.lastSeen).toLocaleTimeString() : "—" })] }, dev.mac))) })] }), networkDevices.length === 0 && (_jsx("p", { style: { textAlign: "center", color: "#9ca3af", padding: "1.5rem" }, children: "No network data yet \u2014 click \"Full Scan\" to discover devices" }))] })] }), homeDevices.length === 0 && networkDevices.length === 0 && !homeLoading && (_jsxs("div", { className: "card", style: { textAlign: "center", padding: "3rem", color: "#9ca3af" }, children: [_jsx("p", { style: { fontSize: "1.1rem", marginBottom: "0.5rem" }, children: "No devices found" }), _jsx("p", { children: "Configure adapters in gateway/.env (HUE_BRIDGE_IP, GOVEE_API_KEY, IFTTT_WEBHOOK_KEY)" })] }))] }))] }));
}
