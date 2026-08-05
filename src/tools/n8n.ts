/**
 * n8n Workflow-Automation Tool
 *
 * Exposes the local n8n instance (default http://127.0.0.1:5678) to the agent
 * as a first-class tool, alongside git/docker/kubernetes/etc.
 *
 * Two surfaces:
 *  - Public REST API (/api/v1/*, auth: X-N8N-API-KEY) for list/get/activate.
 *  - Webhook trigger (/webhook/<path>) to actually run a workflow with a payload.
 *
 * Config: N8N_BASE_URL, N8N_API_KEY (see config.ts).
 */

import { config } from "../config.js";

export type N8nWorkflowSummary = {
  id: string;
  name: string;
  active: boolean;
  tags?: Array<{ id: string; name: string }>;
  updatedAt?: string;
};

export type N8nTriggerResult = {
  status: number;
  ok: boolean;
  body: unknown;
};

export class N8nTool {
  private readonly baseUrl: string;
  private readonly apiKey?: string;

  constructor(baseUrl = config.n8nBaseUrl, apiKey = config.n8nApiKey) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
  }

  private apiHeaders(): Record<string, string> {
    if (!this.apiKey) {
      throw new Error("N8N_API_KEY not configured — create one in n8n Settings > n8n API");
    }
    return { "X-N8N-API-KEY": this.apiKey, Accept: "application/json" };
  }

  private async apiGet<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}/api/v1${path}`, { headers: this.apiHeaders() });
    if (!res.ok) throw new Error(`n8n API GET ${path}: ${res.status} ${res.statusText}`);
    return (await res.json()) as T;
  }

  private async apiPost<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}/api/v1${path}`, {
      method: "POST",
      headers: this.apiHeaders(),
    });
    if (!res.ok) throw new Error(`n8n API POST ${path}: ${res.status} ${res.statusText}`);
    return (await res.json()) as T;
  }

  /** Health probe — does not require an API key. */
  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/healthz`);
      return res.ok;
    } catch {
      return false;
    }
  }

  /** List workflows (optionally only active ones). */
  async listWorkflows(activeOnly = false): Promise<N8nWorkflowSummary[]> {
    const query = activeOnly ? "?active=true" : "";
    const data = await this.apiGet<{ data: N8nWorkflowSummary[] }>(`/workflows${query}`);
    return data.data;
  }

  /** Fetch a single workflow by id. */
  async getWorkflow(id: string): Promise<unknown> {
    return this.apiGet(`/workflows/${encodeURIComponent(id)}`);
  }

  async activate(id: string): Promise<unknown> {
    return this.apiPost(`/workflows/${encodeURIComponent(id)}/activate`);
  }

  async deactivate(id: string): Promise<unknown> {
    return this.apiPost(`/workflows/${encodeURIComponent(id)}/deactivate`);
  }

  /** Recent executions for observability/debugging. */
  async listExecutions(limit = 20): Promise<unknown> {
    return this.apiGet(`/executions?limit=${limit}`);
  }

  /**
   * Run a webhook-triggered workflow by POST/GET to its webhook path.
   * `path` is the Webhook node's path segment (not the full URL).
   * `test=true` targets the /webhook-test/ endpoint used while editing.
   * Honors dryRun (repo convention): returns the planned call without firing.
   */
  async trigger(
    path: string,
    opts: {
      method?: "GET" | "POST";
      payload?: unknown;
      test?: boolean;
      dryRun?: boolean;
    } = {},
  ): Promise<N8nTriggerResult | { dryRun: true; url: string; method: string }> {
    const method = opts.method ?? "POST";
    const segment = opts.test ? "webhook-test" : "webhook";
    const url = `${this.baseUrl}/${segment}/${path.replace(/^\/+/, "")}`;

    if (opts.dryRun) {
      return { dryRun: true, url, method };
    }

    const init: RequestInit = { method };
    if (method === "POST") {
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify(opts.payload ?? {});
    }

    const res = await fetch(url, init);
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* non-JSON webhook response is fine */
    }
    return { status: res.status, ok: res.ok, body };
  }
}
