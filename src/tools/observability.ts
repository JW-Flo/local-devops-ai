import { config } from "../config.js";

export class ObservabilityTool {
  async prometheusQuery(query: string) {
    if (!config.prometheusUrl) {
      throw new Error("PROMETHEUS_URL not configured");
    }
    const url = new URL("/api/v1/query", config.prometheusUrl);
    url.searchParams.set("query", query);
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Prometheus query failed: ${res.status}`);
    }
    return res.json();
  }

  async lokiQuery(query: string, limit = 100) {
    if (!config.lokiUrl) {
      throw new Error("LOKI_URL not configured");
    }
    const url = new URL("/loki/api/v1/query", config.lokiUrl);
    url.searchParams.set("query", query);
    url.searchParams.set("limit", limit.toString());
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Loki query failed: ${res.status}`);
    }
    return res.json();
  }

  async grafanaDashboard(uid: string) {
    if (!config.grafanaUrl) {
      throw new Error("GRAFANA_URL not configured");
    }
    const url = new URL(`/api/dashboards/uid/${uid}`, config.grafanaUrl);
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Grafana request failed: ${res.status}`);
    }
    return res.json();
  }
}
