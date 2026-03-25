/**
 * Common interfaces for all home automation device adapters.
 * Each adapter (Hue, Govee, IFTTT, Alexa) implements DeviceAdapter.
 */

export type DeviceType = "light" | "plug" | "sensor" | "switch" | "group" | "scene" | "unknown";

export type DeviceState = {
  on: boolean;
  brightness?: number;       // 0-100
  colorTemp?: number;        // mireds (Hue native) or kelvin
  hue?: number;              // 0-65535
  saturation?: number;       // 0-254
  xy?: [number, number];     // CIE color space
  reachable?: boolean;
  lastUpdated?: string;
  [key: string]: unknown;    // adapter-specific extras
};

export type Device = {
  id: string;
  name: string;
  type: DeviceType;
  adapter: string;           // "hue" | "govee" | "ifttt" | "alexa"
  room?: string;
  model?: string;
  manufacturer?: string;
  state: DeviceState;
  raw?: unknown;             // raw API payload for debugging
};

export type Scene = {
  id: string;
  name: string;
  adapter: string;
  room?: string;
  deviceIds?: string[];
};
export type SetStateRequest = Partial<Pick<DeviceState, "on" | "brightness" | "colorTemp" | "hue" | "saturation" | "xy">>;

export interface DeviceAdapter {
  readonly name: string;

  /** Check if adapter is configured and reachable */
  isAvailable(): Promise<boolean>;

  /** Discover/list all devices from this adapter */
  listDevices(): Promise<Device[]>;

  /** Get current state of a single device */
  getState(deviceId: string): Promise<DeviceState>;

  /** Set state on a device (partial update) */
  setState(deviceId: string, state: SetStateRequest): Promise<DeviceState>;

  /** List available scenes */
  listScenes(): Promise<Scene[]>;

  /** Activate a scene by ID */
  activateScene(sceneId: string): Promise<void>;
}

export type BridgeInfo = {
  id: string;
  ip: string;
  name?: string;
  model?: string;
  apiVersion?: string;
};