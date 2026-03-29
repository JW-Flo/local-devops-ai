import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';

interface OpenClawConfig {
  openclawRoot: string;
}

interface StatusResponse {
  version: string;
  gatewayPort: number;
  model: string;
  lastTouchedAt: string;
  gatewayHealthy: boolean;
  devices: {
    pairedCount: number;
    displayNames: string[];
  };
  jobs: {
    scheduledCount: number;
  };
  authProviders: Array<{
    name: string;
    provider: string;
    mode: string;
  }>;
  channels: {
    whatsapp: boolean;
  };
}

interface SessionInfo {
  id: string;
  type: string;
  size: string;
  updated: string;
}

interface SkillInfo {
  name: string;
  category: string;
}

function getConfig(): OpenClawConfig {
  const openclawRoot = process.env.OPENCLAW_ROOT || 'D:/openclaw';
  return { openclawRoot };
}

function readJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function readJsonLines(filePath: string, lines: number): Record<string, unknown>[] {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const allLines = content.trim().split('\n').filter(l => l.length > 0);
    const lastLines = allLines.slice(Math.max(0, allLines.length - lines));
    return lastLines.map(line => {
      try { return JSON.parse(line); } catch { return { raw: line }; }
    });
  } catch {
    return [];
  }
}

function safeGet(obj: unknown, ...keys: string[]): unknown {
  let cur: unknown = obj;
  for (const k of keys) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function checkGatewayHealth(port: number, timeout: number = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host: 'localhost' });
    const t = setTimeout(() => { socket.destroy(); resolve(false); }, timeout);
    socket.on('connect', () => { socket.destroy(); clearTimeout(t); resolve(true); });
    socket.on('error', () => { clearTimeout(t); resolve(false); });
  });
}

function createOpenClawRouter(): Router {
  const router = Router();
  const cfg = getConfig();

  // GET /status — orchestrator overview (flat keys for frontend)
  router.get('/status', async (_req: Request, res: Response) => {
    try {
      const oc = readJsonFile(path.join(cfg.openclawRoot, 'openclaw.json'));
      const paired = readJsonFile(path.join(cfg.openclawRoot, 'devices', 'paired.json'));
      const cronFile = readJsonFile(path.join(cfg.openclawRoot, 'cron', 'jobs.json'));

      // --- Orchestrator fields (nested keys) ---
      const version = (safeGet(oc, 'meta', 'lastTouchedVersion') as string) || 'unknown';
      const gatewayPort = (safeGet(oc, 'gateway', 'port') as number) || 18789;
      const model = (safeGet(oc, 'agents', 'defaults', 'model', 'primary') as string) || 'unknown';
      const lastTouchedAt = (safeGet(oc, 'meta', 'lastTouchedAt') as string) || '';
      const gatewayHealthy = await checkGatewayHealth(gatewayPort);

      // --- Devices (paired.json is { [deviceId]: { ...device } }, not an array) ---
      let pairedCount = 0;
      const displayNames: string[] = [];
      if (paired && typeof paired === 'object' && !Array.isArray(paired)) {
        const entries = Object.values(paired);
        pairedCount = entries.length;
        for (const dev of entries) {
          const d = dev as Record<string, unknown>;
          if (d.displayName) displayNames.push(d.displayName as string);
        }
      }

      // --- Cron jobs (jobs.json is { version, jobs: [] }) ---
      const jobs = safeGet(cronFile, 'jobs') as unknown[];
      const scheduledCount = Array.isArray(jobs) ? jobs.length : 0;

      // --- Auth providers from openclaw.json auth.profiles ---
      const profiles = safeGet(oc, 'auth', 'profiles') as Record<string, unknown> | undefined;
      const authProviders: Array<{ name: string; provider: string; mode: string }> = [];
      if (profiles && typeof profiles === 'object') {
        for (const [name, val] of Object.entries(profiles)) {
          const p = val as Record<string, unknown>;
          authProviders.push({
            name,
            provider: (p.provider as string) || 'unknown',
            mode: (p.mode as string) || 'unknown',
          });
        }
      }

      // --- Channels ---
      const whatsappEnabled = safeGet(oc, 'channels', 'whatsapp', 'enabled') === true;

      const response: StatusResponse = {
        version,
        gatewayPort,
        model,
        lastTouchedAt,
        gatewayHealthy,
        devices: { pairedCount, displayNames },
        jobs: { scheduledCount },
        authProviders,
        channels: { whatsapp: whatsappEnabled },
      };

      res.json(response);
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // GET /sessions — list session files with metadata
  router.get('/sessions', (_req: Request, res: Response) => {
    try {
      const sessionsDir = path.join(cfg.openclawRoot, 'agents', 'main', 'sessions');
      const sessionsJsonPath = path.join(sessionsDir, 'sessions.json');
      const sessionList: SessionInfo[] = [];

      // sessions.json is large — read it and extract session metadata
      const raw = readJsonFile(sessionsJsonPath);

      // The file structure: top-level keys are session IDs (like "agent:main:whatsapp:direct:+...")
      // Each has { id, chatType, lastChannel, ... }
      // Also has top-level skillsSnapshot, activeSessions, etc.
      if (raw && typeof raw === 'object') {
        // Look for session-like entries (keys containing "agent:" or having an 'id' property)
        for (const [key, val] of Object.entries(raw)) {
          if (val && typeof val === 'object' && !Array.isArray(val)) {
            const s = val as Record<string, unknown>;
            if (s.id || key.startsWith('agent:')) {
              const sessionId = (s.id as string) || key;
              const chatType = (s.chatType as string) || (s.lastChannel as string) || 'unknown';

              // Try to stat the JSONL file
              let sizeStr = '--';
              const shortId = sessionId.includes(':') ? '' : sessionId;
              if (shortId) {
                try {
                  const jsonlPath = path.join(sessionsDir, `${shortId}.jsonl`);
                  if (fs.existsSync(jsonlPath)) {
                    sizeStr = formatBytes(fs.statSync(jsonlPath).size);
                  }
                } catch { /* ignore */ }
              }

              // Check for linked session files
              if (s.sessionId && typeof s.sessionId === 'string') {
                try {
                  const jsonlPath = path.join(sessionsDir, `${s.sessionId}.jsonl`);
                  if (fs.existsSync(jsonlPath)) {
                    sizeStr = formatBytes(fs.statSync(jsonlPath).size);
                  }
                } catch { /* ignore */ }
              }

              sessionList.push({
                id: sessionId.length > 30 ? sessionId.substring(0, 30) + '...' : sessionId,
                type: chatType,
                size: sizeStr,
                updated: (s.lastActivity as string) || (s.createdAt as string) || '--',
              });
            }
          }
        }

        // Also list JSONL files directly for any we missed
        if (sessionList.length === 0) {
          try {
            const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'));
            for (const file of files) {
              const filePath = path.join(sessionsDir, file);
              const stats = fs.statSync(filePath);
              sessionList.push({
                id: file.replace('.jsonl', '').substring(0, 30),
                type: 'session',
                size: formatBytes(stats.size),
                updated: stats.mtime.toISOString(),
              });
            }
          } catch { /* ignore */ }
        }
      }

      res.json({ sessions: sessionList });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // GET /skills — list installed skills
  router.get('/skills', (_req: Request, res: Response) => {
    try {
      const oc = readJsonFile(path.join(cfg.openclawRoot, 'openclaw.json'));
      const skillEntries = safeGet(oc, 'skills', 'entries') as Record<string, unknown> | undefined;
      const skills: SkillInfo[] = [];

      // skills.entries is { "openai-whisper-api": { apiKey: "..." }, ... }
      if (skillEntries && typeof skillEntries === 'object') {
        for (const name of Object.keys(skillEntries)) {
          skills.push({ name, category: 'installed' });
        }
      }

      // Also check sessions.json for skillsSnapshot (runtime-available skills)
      const sessionsPath = path.join(cfg.openclawRoot, 'agents', 'main', 'sessions', 'sessions.json');
      const sessions = readJsonFile(sessionsPath);
      if (sessions) {
        // Walk all session entries looking for skillsSnapshot arrays
        for (const val of Object.values(sessions)) {
          if (val && typeof val === 'object' && !Array.isArray(val)) {
            const s = val as Record<string, unknown>;
            const snapshot = s.skillsSnapshot;
            if (Array.isArray(snapshot)) {
              for (const sk of snapshot) {
                const skillName = typeof sk === 'string' ? sk : (sk as Record<string, unknown>)?.name as string;
                if (skillName && !skills.some(existing => existing.name === skillName)) {
                  skills.push({ name: skillName, category: 'runtime' });
                }
              }
            }
          }
        }
      }

      res.json({ skills });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // GET /activity — recent config events + session messages
  router.get('/activity', (_req: Request, res: Response) => {
    try {
      const auditPath = path.join(cfg.openclawRoot, 'logs', 'config-audit.jsonl');
      const sessionsDir = path.join(cfg.openclawRoot, 'agents', 'main', 'sessions');

      const configEvents = readJsonLines(auditPath, 20);

      let recentMessages: Record<string, unknown>[] = [];
      try {
        if (fs.existsSync(sessionsDir)) {
          const jsonlFiles = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'));
          if (jsonlFiles.length > 0) {
            let mostRecentFile = jsonlFiles[0];
            let mostRecentTime = 0;
            for (const file of jsonlFiles) {
              const stats = fs.statSync(path.join(sessionsDir, file));
              if (stats.mtimeMs > mostRecentTime) {
                mostRecentTime = stats.mtimeMs;
                mostRecentFile = file;
              }
            }
            recentMessages = readJsonLines(path.join(sessionsDir, mostRecentFile), 10);
          }
        }
      } catch { /* ignore */ }

      res.json({ configEvents, recentMessages });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  return router;
}

export { createOpenClawRouter, type StatusResponse, type SessionInfo, type SkillInfo };
