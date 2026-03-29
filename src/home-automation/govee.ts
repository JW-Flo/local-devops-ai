/**
 * Govee Device Adapter — HTTP API v1 + LAN UDP control
 *
 * Cloud: https://developer-api.govee.com/v1 (Govee-API-Key header)
 * LAN:   UDP to device IP on port 4003 (no auth, local network only)
 *
 * Priority: Cloud API if key configured, else LAN UDP for devices found by scanner.
 * LAN protocol: JSON messages over UDP port 4003
 *   - turn:       { msg: { cmd: "turn", data: { value: 0|1 } } }
 *   - brightness:  { msg: { cmd: "brightness", data: { value: 1-100 } } }
 *   - colorwc:     { msg: { cmd: "colorwc", data: { color: {r,g,b}, colorTemInKelvin: N } } }
 *   - devStatus:   { msg: { cmd: "devStatus", data: {} } }
 */

import { createSocket as createUdpSocket } from "dgram";
import { config } from "../config.js";
import { getGoveeDevicesFromRegistry } from "./network-scanner.js";
import type {
  DeviceAdapter, Device, DeviceState, SetStateRequest, Scene,
} from "./types.js";

const API_BASE = "https://developer-api.govee.com/v1";
const GOVEE_LAN_PORT = 4003;
// ── Cloud API helpers ──────────────────────────────────

function headers(): Record<string, string> {
  if (!config.goveeApiKey) throw new Error("GOVEE_API_KEY not configured");
  return { "Govee-API-Key": config.goveeApiKey, "Content-Type": "application/json" };
}

async function goveeGet<T = unknown>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { headers: headers() });
  if (!res.ok) throw new Error(`Govee API ${path}: ${res.status} ${res.statusText}`);
  const data = await res.json();
  return data.data as T;
}

async function goveePut(path: string, body: unknown): Promise<void> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "PUT", headers: headers(), body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Govee API PUT ${path}: ${res.status}`);
}

// ── LAN UDP helpers ────────────────────────────────────

function sendLanCommand(ip: string, msg: Record<string, unknown>): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const socket = createUdpSocket({ type: "udp4" });
    const payload = JSON.stringify(msg);
    let responded = false;
    socket.on("message", (data) => {
      responded = true;
      try { socket.close(); } catch {}
      resolve(data);
    });

    socket.on("error", () => {
      try { socket.close(); } catch {}
      if (!responded) resolve(null);
    });

    socket.send(payload, 0, payload.length, GOVEE_LAN_PORT, ip, (err) => {
      if (err) {
        try { socket.close(); } catch {}
        resolve(null);
      }
    });

    setTimeout(() => {
      if (!responded) {
        try { socket.close(); } catch {}
        resolve(null);
      }
    }, 2000);
  });
}

async function lanGetStatus(ip: string): Promise<DeviceState | null> {
  const resp = await sendLanCommand(ip, {
    msg: { cmd: "devStatus", data: {} },
  });  if (!resp) return null;
  try {
    const data = JSON.parse(resp.toString());
    if (data?.msg?.cmd === "devStatus" && data.msg.data) {
      const d = data.msg.data;
      const state: DeviceState = {
        on: d.onOff === 1,
        brightness: d.brightness,
        reachable: true,
      };
      if (d.color) {
        const { r, g, b } = d.color;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        let h = 0;
        if (max !== min) {
          if (max === r) h = ((g - b) / (max - min)) % 6;
          else if (max === g) h = (b - r) / (max - min) + 2;
          else h = (r - g) / (max - min) + 4;
          h = Math.round(h * 60); if (h < 0) h += 360;
        }
        state.hue = Math.round((h / 360) * 65535);
      }
      if (d.colorTemInKelvin && d.colorTemInKelvin > 0) {
        state.colorTemp = Math.round(1000000 / d.colorTemInKelvin);
      }
      return state;
    }
  } catch { /* parse failure */ }
  return null;
}
async function lanSetState(ip: string, state: SetStateRequest): Promise<DeviceState> {
  if (state.on !== undefined) {
    await sendLanCommand(ip, {
      msg: { cmd: "turn", data: { value: state.on ? 1 : 0 } },
    });
  }

  if (state.brightness !== undefined) {
    await sendLanCommand(ip, {
      msg: { cmd: "brightness", data: { value: Math.max(1, Math.min(100, state.brightness)) } },
    });
  }

  if (state.hue !== undefined || state.colorTemp !== undefined) {
    const colorData: { color: { r: number; g: number; b: number }; colorTemInKelvin: number } = {
      color: { r: 0, g: 0, b: 0 },
      colorTemInKelvin: 0,
    };

    if (state.hue !== undefined) {
      const h = (state.hue / 65535) * 360;
      const s = 1, v = 1;
      const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
      let r = 0, g = 0, b = 0;
      if (h < 60) { r = c; g = x; }
      else if (h < 120) { r = x; g = c; }
      else if (h < 180) { g = c; b = x; }
      else if (h < 240) { g = x; b = c; }
      else if (h < 300) { r = x; b = c; }
      else { r = c; b = x; }      colorData.color = {
        r: Math.round((r + m) * 255),
        g: Math.round((g + m) * 255),
        b: Math.round((b + m) * 255),
      };
    }

    if (state.colorTemp !== undefined) {
      const kelvin = Math.round(1000000 / state.colorTemp);
      colorData.colorTemInKelvin = Math.max(2000, Math.min(9000, kelvin));
      colorData.color = { r: 0, g: 0, b: 0 };
    }

    await sendLanCommand(ip, {
      msg: { cmd: "colorwc", data: colorData },
    });
  }

  return { on: state.on ?? true, ...state };
}

// ── Govee API types ────────────────────────────────────

type GoveeDevice = {
  device: string;
  model: string;
  deviceName: string;
  controllable: boolean;
  retrievable: boolean;
  supportCmds: string[];
  properties?: Record<string, unknown>;
};
type GoveeDeviceState = {
  device: string;
  model: string;
  properties: Array<Record<string, unknown>>;
};

function parseGoveeState(props: Array<Record<string, unknown>>): DeviceState {
  const state: DeviceState = { on: false };
  for (const p of props) {
    if ("powerState" in p) state.on = p.powerState === "on";
    if ("brightness" in p) state.brightness = p.brightness as number;
    if ("color" in p) {
      const c = p.color as { r: number; g: number; b: number };
      const max = Math.max(c.r, c.g, c.b), min = Math.min(c.r, c.g, c.b);
      let h = 0;
      if (max !== min) {
        if (max === c.r) h = ((c.g - c.b) / (max - min)) % 6;
        else if (max === c.g) h = (c.b - c.r) / (max - min) + 2;
        else h = (c.r - c.g) / (max - min) + 4;
        h = Math.round(h * 60); if (h < 0) h += 360;
      }
      state.hue = Math.round((h / 360) * 65535);
    }
    if ("colorTem" in p && typeof p.colorTem === "number") {
      state.colorTemp = Math.round(1000000 / (p.colorTem as number));
    }
    if ("online" in p) state.reachable = p.online === true || p.online === "true";
  }
  return state;
}
// ── Device cache (Govee API is rate-limited) ───────────

let deviceCache: GoveeDevice[] | null = null;
let cacheTime = 0;
const CACHE_TTL = 60_000;

async function getDeviceList(): Promise<GoveeDevice[]> {
  if (deviceCache && Date.now() - cacheTime < CACHE_TTL) return deviceCache;
  const result = await goveeGet<{ devices: GoveeDevice[] }>("/devices");
  deviceCache = result.devices ?? [];
  cacheTime = Date.now();
  return deviceCache;
}

function findDevice(deviceId: string): { mac: string; model: string } {
  const match = deviceId.match(/^govee-(.+?)-(.+)$/);
  if (!match) throw new Error(`Invalid Govee device ID: ${deviceId}`);
  return { mac: match[2], model: match[1] };
}

// ── Determine control mode ─────────────────────────────

type ControlMode = "cloud" | "lan" | "none";

function getControlMode(): ControlMode {
  if (config.goveeApiKey) return "cloud";
  const lanDevices = getGoveeDevicesFromRegistry();
  if (lanDevices.length > 0) return "lan";
  return "none";
}
function getLanIpForDevice(deviceId: string): string | null {
  const lanDevices = getGoveeDevicesFromRegistry();
  const lanMatch = deviceId.match(/^govee-lan-(.+)$/);
  if (lanMatch) return lanMatch[1];
  const { mac } = findDevice(deviceId);
  const found = lanDevices.find((d) =>
    d.mac.replace(/-/g, ":").toLowerCase() === mac.replace(/:/g, ":").toLowerCase()
  );
  return found?.ip ?? null;
}

// ── The Adapter ────────────────────────────────────────

export const goveeAdapter: DeviceAdapter = {
  name: "govee",

  async isAvailable(): Promise<boolean> {
    if (config.goveeApiKey) {
      try { await getDeviceList(); return true; } catch { /* fall through */ }
    }
    const lanDevices = getGoveeDevicesFromRegistry();
    return lanDevices.length > 0;
  },

  async listDevices(): Promise<Device[]> {
    const devices: Device[] = [];
    const mode = getControlMode();
    // Cloud devices
    if (mode === "cloud") {
      const goveeDevices = await getDeviceList();
      for (const gd of goveeDevices) {
        let state: DeviceState = { on: false };
        if (gd.retrievable) {
          try {
            const ds = await goveeGet<GoveeDeviceState>(
              `/devices/state?device=${encodeURIComponent(gd.device)}&model=${gd.model}`
            );
            state = parseGoveeState(ds.properties);
          } catch { /* offline device */ }
        }
        devices.push({
          id: `govee-${gd.model}-${gd.device}`,
          name: gd.deviceName,
          type: gd.model.startsWith("H61") || gd.model.startsWith("H70") ? "light" : "unknown",
          adapter: "govee",
          model: gd.model,
          manufacturer: "Govee",
          state,
          raw: gd,
        });
      }
    }
    // LAN devices (from network scanner registry)
    const lanDevices = getGoveeDevicesFromRegistry();
    for (const ld of lanDevices) {
      if (devices.some((d) => {
        const lanIp = getLanIpForDevice(d.id);
        return lanIp === ld.ip;
      })) continue;

      let state: DeviceState = { on: false, reachable: ld.online };
      if (ld.online) {
        const lanState = await lanGetStatus(ld.ip);
        if (lanState) state = lanState;
      }

      const modelTag = ld.tags.find((t) => t.startsWith("govee-model:"));
      const model = modelTag?.split(":")[1] ?? "unknown";

      devices.push({
        id: `govee-lan-${ld.ip}`,
        name: ld.hostname ?? `Govee ${ld.ip}`,
        type: "light",
        adapter: "govee",
        model,
        manufacturer: "Govee",
        room: "LAN",
        state,
        raw: { ip: ld.ip, mac: ld.mac, tags: ld.tags, controlMode: "lan" },
      });
    }

    return devices;
  },
  async getState(deviceId: string): Promise<DeviceState> {
    const lanIp = getLanIpForDevice(deviceId);
    if (lanIp) {
      const lanState = await lanGetStatus(lanIp);
      if (lanState) return lanState;
    }
    if (config.goveeApiKey) {
      const { mac, model } = findDevice(deviceId);
      const ds = await goveeGet<GoveeDeviceState>(
        `/devices/state?device=${encodeURIComponent(mac)}&model=${model}`
      );
      return parseGoveeState(ds.properties);
    }
    return { on: false, reachable: false };
  },

  async setState(deviceId: string, state: SetStateRequest): Promise<DeviceState> {
    const lanIp = getLanIpForDevice(deviceId);
    if (lanIp) {
      return lanSetState(lanIp, state);
    }

    if (!config.goveeApiKey) throw new Error("No Govee control path available (no API key, no LAN device)");
    const { mac, model } = findDevice(deviceId);
    const cmds: Array<{ name: string; value: unknown }> = [];
    if (state.on !== undefined) cmds.push({ name: "turn", value: state.on ? "on" : "off" });
    if (state.brightness !== undefined) cmds.push({ name: "brightness", value: state.brightness });
    if (state.colorTemp !== undefined) {
      const kelvin = Math.round(1000000 / state.colorTemp);
      cmds.push({ name: "colorTem", value: kelvin });
    }
    if (state.hue !== undefined) {
      const h = (state.hue / 65535) * 360;
      const s = 1, v = 1;
      const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
      let r = 0, g = 0, b = 0;
      if (h < 60) { r = c; g = x; }
      else if (h < 120) { r = x; g = c; }
      else if (h < 180) { g = c; b = x; }
      else if (h < 240) { g = x; b = c; }
      else if (h < 300) { r = x; b = c; }
      else { r = c; b = x; }
      cmds.push({
        name: "color",
        value: { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) },
      });
    }

    for (const cmd of cmds) {
      await goveePut("/devices/control", { device: mac, model, cmd });
    }
    return { on: state.on ?? true, ...state };
  },

  async listScenes(): Promise<Scene[]> { return []; },
  async activateScene(_sceneId: string): Promise<void> {
    throw new Error("Govee scenes not supported via API v1");
  },
};
