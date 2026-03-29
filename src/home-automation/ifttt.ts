/**
 * IFTTT Webhook Adapter
 *
 * Uses IFTTT Webhooks service to trigger applets.
 * Not a full device adapter — it fires events that IFTTT routes to services.
 * Devices are "virtual triggers" defined in config.
 *
 * Trigger URL: https://maker.ifttt.com/trigger/{event}/json/with/key/{key}
 */

import { config } from "../config.js";
import type {
  DeviceAdapter, Device, DeviceState, SetStateRequest, Scene,
} from "./types.js";

const IFTTT_BASE = "https://maker.ifttt.com/trigger";

async function triggerWebhook(event: string, values?: Record<string, string>): Promise<void> {
  if (!config.iftttWebhookKey) throw new Error("IFTTT_WEBHOOK_KEY not configured");
  const url = `${IFTTT_BASE}/${event}/json/with/key/${config.iftttWebhookKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(values ?? {}),
  });
  if (!res.ok) throw new Error(`IFTTT webhook ${event}: ${res.status}`);
}
// IFTTT "devices" are virtual triggers from config.
// Each maps an event name to a friendly name.
// Example in .env: IFTTT_TRIGGERS=lights_on:All Lights On,lights_off:All Lights Off

function parseTriggers(): Array<{ event: string; name: string }> {
  const raw = config.iftttTriggers ?? "";
  if (!raw) return [];
  return raw.split(",").map((t) => {
    const [event, ...nameParts] = t.trim().split(":");
    return { event: event.trim(), name: nameParts.join(":").trim() || event.trim() };
  }).filter((t) => t.event);
}

// Virtual state tracker (IFTTT has no state query)
const stateMap = new Map<string, DeviceState>();

export const iftttAdapter: DeviceAdapter = {
  name: "ifttt",

  async isAvailable(): Promise<boolean> {
    return !!config.iftttWebhookKey;
  },

  async listDevices(): Promise<Device[]> {
    const triggers = parseTriggers();
    return triggers.map((t) => {
      const id = `ifttt-${t.event}`;
      const state = stateMap.get(id) ?? { on: false };
      return {
        id, name: t.name, type: "switch" as const,
        adapter: "ifttt", manufacturer: "IFTTT",
        state, raw: { event: t.event },
      };
    });
  },

  async getState(deviceId: string): Promise<DeviceState> {
    return stateMap.get(deviceId) ?? { on: false };
  },

  async setState(deviceId: string, state: SetStateRequest): Promise<DeviceState> {
    const match = deviceId.match(/^ifttt-(.+)$/);
    if (!match) throw new Error(`Invalid IFTTT device ID: ${deviceId}`);
    const event = match[1];
    const values: Record<string, string> = {};
    if (state.on !== undefined) values.value1 = state.on ? "on" : "off";
    if (state.brightness !== undefined) values.value2 = String(state.brightness);
    await triggerWebhook(event, values);
    const newState: DeviceState = { on: state.on ?? true, ...state };
    stateMap.set(deviceId, newState);
    return newState;
  },

  async listScenes(): Promise<Scene[]> { return []; },
  async activateScene(_id: string): Promise<void> {
    throw new Error("IFTTT scenes: use triggers instead");
  },
};