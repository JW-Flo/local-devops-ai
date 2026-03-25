const LOCAL_API = "http://127.0.0.1:4124";
const runtimeHost = typeof window !== "undefined" ? window.location.hostname : undefined;
const shouldUseLocal = runtimeHost === "localhost" || runtimeHost === "127.0.0.1";
const API_BASE = shouldUseLocal ? LOCAL_API : import.meta.env.VITE_API_BASE ?? LOCAL_API;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(err.message ?? "Request failed");
  }
  const data = await res.json();
  return data.data as T;
}

export function createEventSource(): EventSource {
  return new EventSource(`${API_BASE}/events`);
}

export const api = {
  createTask: (payload: unknown) =>
    request("/tasks", { method: "POST", body: JSON.stringify(payload) }),
  listApprovals: () => request("/approvals"),
  approve: (id: string) => request(`/approvals/${id}/approve`, { method: "POST" }),
  reject: (id: string) => request(`/approvals/${id}/reject`, { method: "POST" }),  listSchedules: () => request("/schedules"),
  addSchedule: (payload: unknown) =>
    request("/schedules", { method: "POST", body: JSON.stringify(payload) }),
  deleteSchedule: (id: string) => request(`/schedules/${id}`, { method: "DELETE" }),
  listMemories: () => request("/memories"),
  addMemory: (payload: unknown) =>
    request("/memories", { method: "POST", body: JSON.stringify(payload) }),
  getKnowledge: () => request("/knowledge"),
  ingestKnowledge: () => request("/knowledge/ingest", { method: "POST" }),
  // Metrics & Agent
  getMetrics: () => request("/metrics"),
  getAgentState: () => request("/agent/state"),
  runAgent: () => request("/agent/run", { method: "POST" }),
  // GitHub — dynamic owner/repo
  githubRepos: () => request("/github/repos"),
  githubRegistry: () => request("/github/registry"),
  githubAddRepo: (owner: string, name: string) =>
    request("/github/registry", { method: "POST", body: JSON.stringify({ owner, name }) }),
  githubRemoveRepo: (owner: string, name: string) =>
    request(`/github/registry/${owner}/${name}`, { method: "DELETE" }),
  githubDiscover: (owner: string) => request(`/github/discover/${owner}`),
  githubSync: (owner: string, repo: string) =>
    request(`/github/sync/${owner}/${repo}`, { method: "POST" }),
  // Auth
  getAuthStatus: () => request("/auth/status"),
  getAuthUrl: () => request<{ url: string }>("/auth/github"),
  logout: () => request("/auth/logout", { method: "POST" }),
  githubTree: (owner: string, repo: string, branch?: string) =>
    request(`/github/tree/${owner}/${repo}${branch ? `?branch=${branch}` : ""}`),
  githubSummary: (owner: string, repo: string) =>
    request(`/github/summary/${owner}/${repo}`),
  // Home Automation
  homeStatus: () => request("/home/status"),
  homeDevices: (adapter?: string) =>
    request(`/home/devices${adapter ? `?adapter=${adapter}` : ""}`),
  homeDeviceState: (id: string) => request(`/home/devices/${id}`),
  homeSetState: (id: string, state: Record<string, unknown>) =>
    request(`/home/devices/${id}`, { method: "PUT", body: JSON.stringify(state) }),
  homeScenes: () => request("/home/scenes"),
  homeActivateScene: (id: string) =>
    request(`/home/scenes/${id}`, { method: "POST" }),
  homeHueDiscover: () => request("/home/hue/discover"),
  homeHueRegister: (ip: string) =>
    request("/home/hue/register", { method: "POST", body: JSON.stringify({ ip }) }),
  // Network scanner
  homeNetwork: () => request("/home/network"),
  homeNetworkScan: (quick = false) =>
    request("/home/network/scan", { method: "POST", body: JSON.stringify({ quick }) }),
  homeNetworkGovee: () => request("/home/network/govee"),
  homeNetworkMonitorStart: (intervalMs = 300000) =>
    request("/home/network/monitor/start", { method: "POST", body: JSON.stringify({ intervalMs }) }),
  homeNetworkMonitorStop: () =>
    request("/home/network/monitor/stop", { method: "POST" }),
};