/**
 * Home Automation route group — mounted at /home on the gateway.
 *
 * Routes:
 *   GET  /home/devices          — list all devices across adapters
 *   GET  /home/devices/:id      — get single device state
 *   PUT  /home/devices/:id      — set device state
 *   GET  /home/scenes           — list all scenes
 *   POST /home/scenes/:id       — activate a scene
 *   GET  /home/hue/discover     — discover Hue bridges on network
 *   POST /home/hue/register     — register with a Hue bridge (link button)
 *   GET  /home/status           — adapter availability summary
 */

import { Router } from "express";
import { broadcast } from "../events.js";
import { hueAdapter, discoverBridges, registerBridge } from "./hue.js";
import { goveeAdapter } from "./govee.js";
import { iftttAdapter } from "./ifttt.js";
import { alexaAdapter } from "./alexa.js";
import {
  scanNetwork, getRegistry as getNetworkRegistry,
  getGoveeDevicesFromRegistry, startPeriodicScan, stopPeriodicScan,
} from "./network-scanner.js";
import type { DeviceAdapter } from "./types.js";

const router = Router();

// Registry of all adapters
const adapters: DeviceAdapter[] = [hueAdapter, goveeAdapter, iftttAdapter, alexaAdapter];

function getAdapter(deviceId: string): DeviceAdapter | undefined {
  if (deviceId.startsWith("hue-")) return hueAdapter;
  if (deviceId.startsWith("govee-")) return goveeAdapter;  if (deviceId.startsWith("ifttt-")) return iftttAdapter;
  if (deviceId.startsWith("alexa-")) return alexaAdapter;
  return undefined;
}

// ── GET /home/status ───────────────────────────────────

router.get("/status", async (_req, res) => {
  const status: Record<string, boolean> = {};
  for (const a of adapters) {
    try { status[a.name] = await a.isAvailable(); }
    catch { status[a.name] = false; }
  }
  res.json({ status: "success", data: { adapters: status } });
});

// ── GET /home/devices ──────────────────────────────────

router.get("/devices", async (req, res) => {
  const adapterFilter = req.query.adapter as string | undefined;
  try {
    const all = await Promise.all(
      adapters
        .filter((a) => !adapterFilter || a.name === adapterFilter)
        .map(async (a) => {
          try {
            if (!(await a.isAvailable())) return [];
            return a.listDevices();
          } catch (err) {
            console.warn(`[home] ${a.name} listDevices failed:`, (err as Error).message);
            return [];
          }
        }),
    );
    const devices = all.flat();
    res.json({ status: "success", data: { count: devices.length, devices } });
  } catch (err) {
    res.status(500).json({ status: "error", message: (err as Error).message });
  }
});
// ── GET /home/devices/:id ──────────────────────────────

router.get("/devices/:id", async (req, res) => {
  const adapter = getAdapter(req.params.id);
  if (!adapter) return res.status(404).json({ status: "error", message: "Unknown adapter for device ID" });
  try {
    const state = await adapter.getState(req.params.id);
    res.json({ status: "success", data: { id: req.params.id, state } });
  } catch (err) {
    res.status(500).json({ status: "error", message: (err as Error).message });
  }
});

// ── PUT /home/devices/:id ──────────────────────────────

router.put("/devices/:id", async (req, res) => {
  const adapter = getAdapter(req.params.id);
  if (!adapter) return res.status(404).json({ status: "error", message: "Unknown adapter for device ID" });
  try {
    const newState = await adapter.setState(req.params.id, req.body);
    broadcast("home:device:state", { id: req.params.id, adapter: adapter.name, state: newState });
    res.json({ status: "success", data: { id: req.params.id, state: newState } });
  } catch (err) {
    res.status(500).json({ status: "error", message: (err as Error).message });
  }
});

// ── GET /home/scenes ───────────────────────────────────

router.get("/scenes", async (_req, res) => {
  try {
    const all = await Promise.all(
      adapters.map(async (a) => {
        try {
          if (!(await a.isAvailable())) return [];
          return a.listScenes();
        } catch { return []; }
      }),
    );
    const scenes = all.flat();
    res.json({ status: "success", data: { count: scenes.length, scenes } });
  } catch (err) {
    res.status(500).json({ status: "error", message: (err as Error).message });
  }
});
// ── POST /home/scenes/:id ──────────────────────────────

router.post("/scenes/:id", async (req, res) => {
  const adapter = getAdapter(req.params.id);
  if (!adapter) return res.status(404).json({ status: "error", message: "Unknown adapter for scene ID" });
  try {
    await adapter.activateScene(req.params.id);
    broadcast("home:scene:activated", { id: req.params.id });
    res.json({ status: "success", data: { id: req.params.id, activated: true } });
  } catch (err) {
    res.status(500).json({ status: "error", message: (err as Error).message });
  }
});

// ── GET /home/hue/discover ─────────────────────────────

router.get("/hue/discover", async (_req, res) => {
  try {
    const bridges = await discoverBridges();
    res.json({ status: "success", data: { count: bridges.length, bridges } });
  } catch (err) {
    res.status(500).json({ status: "error", message: (err as Error).message });
  }
});

// ── POST /home/hue/register ────────────────────────────

router.post("/hue/register", async (req, res) => {
  const ip = req.body?.ip;
  if (!ip) return res.status(400).json({ status: "error", message: "ip required in body" });
  const result = await registerBridge(ip);
  if ("error" in result) {
    return res.status(400).json({ status: "error", message: result.error });
  }
  res.json({
    status: "success",
    data: {
      username: result.username,
      instructions: "Add to gateway/.env: HUE_BRIDGE_IP=<ip> and HUE_API_KEY=<username>, then restart gateway.",
    },
  });
});

// ── GET /home/network ──────────────────────────────────
// Returns cached network device registry

router.get("/network", (_req, res) => {
  const devices = getNetworkRegistry();
  res.json({
    status: "success",
    data: {
      total: devices.length,
      online: devices.filter((d) => d.online).length,
      devices,
    },
  });
});

// ── POST /home/network/scan ────────────────────────────
// Triggers a fresh network scan (ARP + port probe + Govee LAN)

router.post("/network/scan", async (req, res) => {
  try {
    const skipPingSweep = req.body?.quick === true;
    const result = await scanNetwork({ skipPingSweep });
    res.json({ status: "success", data: result });
  } catch (err) {
    res.status(500).json({ status: "error", message: (err as Error).message });
  }
});

// ── GET /home/network/govee ────────────────────────────
// Returns devices tagged as Govee from the network registry

router.get("/network/govee", (_req, res) => {
  const devices = getGoveeDevicesFromRegistry();
  res.json({ status: "success", data: { count: devices.length, devices } });
});

// ── POST /home/network/monitor/start ───────────────────

router.post("/network/monitor/start", (req, res) => {
  const intervalMs = req.body?.intervalMs ?? 300_000; // default 5 min
  startPeriodicScan(intervalMs);
  res.json({ status: "success", data: { monitoring: true, intervalMs } });
});

// ── POST /home/network/monitor/stop ────────────────────

router.post("/network/monitor/stop", (_req, res) => {
  stopPeriodicScan();
  res.json({ status: "success", data: { monitoring: false } });
});

export { router as homeRouter };