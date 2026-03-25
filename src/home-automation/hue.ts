/**
 * Philips Hue Bridge Adapter — v1 CLIP API
 *
 * Discovery: https://discovery.meethue.com/ (cloud) or mDNS fallback
 * Auth: POST /api with devicetype, user presses link button
 * Control: GET/PUT /api/<key>/lights, /groups, /scenes
 */

import { config } from "../config.js";
import type {
  DeviceAdapter, Device, DeviceState, SetStateRequest, Scene, BridgeInfo, DeviceType,
} from "./types.js";

const DISCOVERY_URL = "https://discovery.meethue.com/";
const APP_NAME = "local-devops-ai#gateway";

function bridgeUrl(path: string): string {
  const ip = config.hueBridgeIp;
  const key = config.hueApiKey;
  if (!ip) throw new Error("HUE_BRIDGE_IP not configured");
  if (!key) throw new Error("HUE_API_KEY not configured — run POST /home/hue/register first");
  return `http://${ip}/api/${key}${path}`;
}
async function hueGet<T = unknown>(path: string): Promise<T> {
  const url = bridgeUrl(path);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Hue API ${path}: ${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

async function huePut<T = unknown>(path: string, body: unknown): Promise<T> {
  const url = bridgeUrl(path);
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Hue API PUT ${path}: ${res.status}`);
  return res.json() as Promise<T>;
}

// ── Discovery ──────────────────────────────────────────

export async function discoverBridges(): Promise<BridgeInfo[]> {
  try {
    const res = await fetch(DISCOVERY_URL);
    const data = (await res.json()) as Array<{ id: string; internalipaddress: string; name?: string }>;
    return data.map((b) => ({
      id: b.id,
      ip: b.internalipaddress,
      name: b.name,
    }));
  } catch (err) {
    console.warn("[hue] Cloud discovery failed, trying local fallback:", (err as Error).message);
    return [];
  }
}
// ── Registration (link-button auth) ────────────────────

export async function registerBridge(bridgeIp: string): Promise<{ username: string } | { error: string }> {
  try {
    const res = await fetch(`http://${bridgeIp}/api`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ devicetype: APP_NAME }),
    });
    const data = (await res.json()) as Array<{ success?: { username: string }; error?: { description: string } }>;
    if (data[0]?.success) {
      return { username: data[0].success.username };
    }
    return { error: data[0]?.error?.description ?? "Unknown registration error — press the link button and retry" };
  } catch (err) {
    return { error: `Connection failed: ${(err as Error).message}` };
  }
}

// ── Helpers: map Hue API types to our common types ─────

function mapLightType(hueType: string): DeviceType {
  const t = hueType.toLowerCase();
  if (t.includes("light") || t.includes("lamp") || t.includes("bulb") || t.includes("strip")) return "light";
  if (t.includes("plug") || t.includes("outlet")) return "plug";
  if (t.includes("sensor") || t.includes("motion") || t.includes("temperature")) return "sensor";
  return "light"; // Hue devices are mostly lights
}
function mapLightState(state: Record<string, unknown>): DeviceState {
  return {
    on: state.on as boolean ?? false,
    brightness: state.bri != null ? Math.round(((state.bri as number) / 254) * 100) : undefined,
    colorTemp: state.ct as number | undefined,
    hue: state.hue as number | undefined,
    saturation: state.sat as number | undefined,
    xy: state.xy as [number, number] | undefined,
    reachable: state.reachable as boolean | undefined,
  };
}

function toHueState(req: SetStateRequest): Record<string, unknown> {
  const s: Record<string, unknown> = {};
  if (req.on !== undefined) s.on = req.on;
  if (req.brightness !== undefined) s.bri = Math.round((req.brightness / 100) * 254);
  if (req.colorTemp !== undefined) s.ct = req.colorTemp;
  if (req.hue !== undefined) s.hue = req.hue;
  if (req.saturation !== undefined) s.sat = req.saturation;
  if (req.xy !== undefined) s.xy = req.xy;
  return s;
}

// ── Group/room lookup cache (lazy) ─────────────────────

let groupCache: Map<string, string> | null = null;

async function getRoomForLight(lightId: string): Promise<string | undefined> {
  if (!groupCache) {
    groupCache = new Map();
    try {
      const groups = await hueGet<Record<string, { name: string; type: string; lights: string[] }>>("/groups");
      for (const [, g] of Object.entries(groups)) {
        if (g.type === "Room") {
          for (const lid of g.lights) groupCache.set(lid, g.name);
        }
      }
    } catch { /* cache miss is fine */ }
  }
  return groupCache.get(lightId);
}
// ── The Adapter ────────────────────────────────────────

export const hueAdapter: DeviceAdapter = {
  name: "hue",

  async isAvailable(): Promise<boolean> {
    if (!config.hueBridgeIp || !config.hueApiKey) return false;
    try {
      const res = await fetch(`http://${config.hueBridgeIp}/api/${config.hueApiKey}/config`);
      return res.ok;
    } catch {
      return false;
    }
  },

  async listDevices(): Promise<Device[]> {
    groupCache = null; // refresh room cache
    const lights = await hueGet<Record<string, Record<string, unknown>>>("/lights");
    const devices: Device[] = [];

    for (const [id, light] of Object.entries(lights)) {
      const room = await getRoomForLight(id);
      devices.push({
        id: `hue-light-${id}`,
        name: (light.name as string) ?? `Light ${id}`,
        type: mapLightType((light.type as string) ?? "light"),
        adapter: "hue",
        room,
        model: light.modelid as string | undefined,
        manufacturer: light.manufacturername as string | undefined,
        state: mapLightState((light.state as Record<string, unknown>) ?? {}),
        raw: light,
      });
    }
    // Also add groups as "group" devices for room-level control
    const groups = await hueGet<Record<string, Record<string, unknown>>>("/groups");
    for (const [id, group] of Object.entries(groups)) {
      const action = (group.action as Record<string, unknown>) ?? {};
      devices.push({
        id: `hue-group-${id}`,
        name: (group.name as string) ?? `Group ${id}`,
        type: "group",
        adapter: "hue",
        room: (group.type as string) === "Room" ? (group.name as string) : undefined,
        state: {
          on: (action.on as boolean) ?? false,
          brightness: action.bri != null ? Math.round(((action.bri as number) / 254) * 100) : undefined,
          reachable: true,
        },
        raw: group,
      });
    }

    return devices;
  },

  async getState(deviceId: string): Promise<DeviceState> {
    const match = deviceId.match(/^hue-(light|group)-(\d+)$/);
    if (!match) throw new Error(`Invalid Hue device ID: ${deviceId}`);
    const [, kind, id] = match;

    if (kind === "light") {
      const light = await hueGet<Record<string, unknown>>(`/lights/${id}`);
      return mapLightState((light.state as Record<string, unknown>) ?? {});
    } else {
      const group = await hueGet<Record<string, unknown>>(`/groups/${id}`);
      const action = (group.action as Record<string, unknown>) ?? {};
      return mapLightState(action);
    }
  },
  async setState(deviceId: string, state: SetStateRequest): Promise<DeviceState> {
    const match = deviceId.match(/^hue-(light|group)-(\d+)$/);
    if (!match) throw new Error(`Invalid Hue device ID: ${deviceId}`);
    const [, kind, id] = match;
    const hueState = toHueState(state);

    if (kind === "light") {
      await huePut(`/lights/${id}/state`, hueState);
    } else {
      await huePut(`/groups/${id}/action`, hueState);
    }

    // Return fresh state after applying
    return this.getState(deviceId);
  },

  async listScenes(): Promise<Scene[]> {
    const scenes = await hueGet<Record<string, Record<string, unknown>>>("/scenes");
    return Object.entries(scenes).map(([id, s]) => ({
      id: `hue-scene-${id}`,
      name: (s.name as string) ?? `Scene ${id}`,
      adapter: "hue",
      room: s.group ? `Group ${s.group}` : undefined,
      deviceIds: (s.lights as string[] | undefined)?.map((l) => `hue-light-${l}`),
    }));
  },

  async activateScene(sceneId: string): Promise<void> {
    const match = sceneId.match(/^hue-scene-(.+)$/);
    if (!match) throw new Error(`Invalid Hue scene ID: ${sceneId}`);
    const rawId = match[1];
    // Activate scene via group 0 (all lights)
    await huePut("/groups/0/action", { scene: rawId });
  },
};