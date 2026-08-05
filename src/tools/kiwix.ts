/**
 * Kiwix / Wikipedia (ZIM) Tool
 *
 * Full-text search + article retrieval over the local offline Wikipedia,
 * served by the libzim-backed zim-server (default http://127.0.0.1:5690).
 * Only the requested article is decompressed per call (ms latency); the
 * ZIM stays compressed on disk.
 *
 * Config: KIWIX_URL (see config.ts).
 */

import { config } from "../config.js";

export type KiwixSearchResult = {
  path: string;
  title: string;
  snippet: string;
};

export type KiwixArticle = {
  path: string;
  title: string;
  text: string;
};

export class KiwixTool {
  private readonly baseUrl: string;

  constructor(baseUrl = config.kiwixUrl) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`);
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Full-text search across all Wikipedia articles. */
  async search(query: string, limit = 8): Promise<KiwixSearchResult[]> {
    const url = `${this.baseUrl}/search?q=${encodeURIComponent(query)}&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Kiwix search ${res.status}: ${res.statusText}`);
    const data = (await res.json()) as { results: KiwixSearchResult[] };
    return data.results ?? [];
  }

  /** Fetch a single article's plain text by its ZIM path. */
  async getArticle(path: string): Promise<KiwixArticle> {
    const url = `${this.baseUrl}/article?path=${encodeURIComponent(path)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Kiwix article ${res.status}: ${res.statusText}`);
    return (await res.json()) as KiwixArticle;
  }
}
