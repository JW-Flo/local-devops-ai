/**
 * Alexa Smart Home Adapter — Stub
 *
 * Full integration requires an Alexa Smart Home Skill with
 * Lambda backend + LWA (Login with Amazon) OAuth flow.
 * This stub provides the interface so the home-automation
 * router can register it. Actual implementation comes later
 * when the Alexa Skill is set up.
 *
 * For now, Alexa integration is best handled via IFTTT triggers
 * or Hue scenes (Alexa already controls Hue natively).
 */

import type {
  DeviceAdapter, Device, DeviceState, SetStateRequest, Scene,
} from "./types.js";

export const alexaAdapter: DeviceAdapter = {
  name: "alexa",

  async isAvailable(): Promise<boolean> {
    // Will check for Alexa Smart Home Skill credentials when implemented
    return false;
  },

  async listDevices(): Promise<Device[]> { return []; },

  async getState(_deviceId: string): Promise<DeviceState> {
    throw new Error("Alexa adapter not yet implemented");
  },

  async setState(_deviceId: string, _state: SetStateRequest): Promise<DeviceState> {
    throw new Error("Alexa adapter not yet implemented");
  },

  async listScenes(): Promise<Scene[]> { return []; },

  async activateScene(_sceneId: string): Promise<void> {
    throw new Error("Alexa adapter not yet implemented");
  },
};