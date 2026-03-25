/**
 * Network Scanner — ARP-based device discovery + OUI lookup + port probing
 *
 * Scans the local subnet for active hosts, resolves MAC vendors,
 * probes known smart-home ports, and maintains a persistent device registry.
 *
 * Key ports probed:
 *   80/443   — Web interfaces (Hue bridge, routers)
 *   4001     — Govee LAN API (UDP multicast listen)
 *   4002     — Govee LAN API (device responses)
 *   4003     — Govee LAN API (control commands)
 *   8008     — Chromecast
 *   8443     — Hue bridge HTTPS
 *   9197     — Alexa
 *   11434    — Ollama
 *   6333     — Qdrant
 */

import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { createConnection } from "net";
import { createSocket as createUdpSocket } from "dgram";
import { resolve } from "path";
import { config } from "../config.js";
import { broadcast } from "../events.js";// ── Types ──────────────────────────────────────────────

export type NetworkDevice = {
  ip: string;
  mac: string;
  vendor: string;
  hostname?: string;
  openPorts: number[];
  deviceType: "smart-light" | "bridge" | "speaker" | "router" | "computer" | "phone" | "nas" | "printer" | "iot" | "unknown";
  tags: string[];
  firstSeen: string;
  lastSeen: string;
  online: boolean;
};

export type ScanResult = {
  subnet: string;
  scannedAt: string;
  duration: number;
  hosts: NetworkDevice[];
};
// ── OUI vendor lookup (enriched from IEEE + network scan results) ──

const OUI_DB: Record<string, string> = {
  // Philips Hue / Signify
  "ec:b5:fa": "Signify (Philips Hue)",
  "00:17:88": "Signify (Philips Hue)",
  // Govee OUIs
  "d4:ad:fc": "Govee",
  "34:e1:d1": "Govee",
  "c8:e2:65": "Govee/Espressif",
  // Espressif (common in Govee, Tuya, generic IoT)
  "a4:c1:38": "Espressif (IoT)",
  "30:ae:a4": "Espressif (IoT)",
  "24:6f:28": "Espressif (IoT)",
  "48:3f:da": "Espressif (IoT)",
  "7c:9e:bd": "Espressif (IoT)",
  "cc:50:e3": "Espressif (IoT)",
  // Google / Chromecast / Nest
  "f0:ef:86": "Google (Chromecast/Nest)",
  "54:60:09": "Google (Chromecast/Nest)",
  "d8:6c:63": "Google (Chromecast/Nest)",
  // Apple
  "1c:f2:9a": "Apple",
  "f4:5c:89": "Apple",
  "a0:78:17": "Apple",  // Amazon Echo / Alexa
  "18:b4:30": "Amazon (Echo/Alexa)",
  "fc:65:de": "Amazon (Echo/Alexa)",
  "44:00:49": "Amazon (Echo/Alexa)",
  "68:54:fd": "Amazon (Echo/Alexa)",
  "74:c2:46": "Amazon (Echo/Alexa)",
  "38:f7:3d": "Amazon (Echo/Alexa)",
  "74:ec:b2": "Amazon (Echo/Alexa)",
  // Router / ISP
  "28:25:5f": "Arris/AT&T Router",
  // Western Digital (NAS)
  "00:90:a9": "Western Digital",
  // LIFI Labs (smart lighting — likely LIFX bulbs)
  "d0:73:d5": "LIFX (LIFI Labs)",
  // GE Lighting (C by GE / Cync)
  "78:6d:eb": "GE Lighting (Cync)",
  // ASRock (PC motherboard)
  "70:85:c2": "ASRock (PC)",
  // FN-LINK (WiFi module — generic IoT)
  "2c:d2:6b": "FN-LINK (WiFi Module)",
  // Tuya Smart (IoT platform — smart plugs, switches, etc.)
  "38:1f:8d": "Tuya Smart",
  // Hewlett Packard (printers, etc.)
  "c8:d3:ff": "HP (Hewlett Packard)",
  // Wyze Labs (cameras, sensors, smart home)
  "d0:3f:27": "Wyze Labs",
  // Previously partially identified
  "ac:f1:08": "Unknown (ACF108)",
  "b4:fb:e4": "Unknown (B4FBE4)",
};
/**
 * Detect locally-administered (randomized) MAC addresses.
 * The second hex digit's LSB bit 1 (the "locally administered" bit) being set
 * means: 2, 3, 6, 7, A, B, E, F in the second nibble.
 */
function isRandomizedMac(mac: string): boolean {
  const normalized = mac.replace(/[-:]/g, "").toLowerCase();
  if (normalized.length < 2) return false;
  const secondNibble = parseInt(normalized[1], 16);
  return (secondNibble & 0x2) !== 0;
}

function lookupVendor(mac: string): string {
  if (isRandomizedMac(mac)) return "Randomized (Private)";
  const prefix = mac.toLowerCase().replace(/-/g, ":").slice(0, 8);
  return OUI_DB[prefix] ?? "Unknown";
}

function classifyDevice(vendor: string, openPorts: number[], mac: string): { type: NetworkDevice["deviceType"]; tags: string[] } {
  const tags: string[] = [];
  let type: NetworkDevice["deviceType"] = "unknown";
  const v = vendor.toLowerCase();

  if (isRandomizedMac(mac)) {
    tags.push("randomized-mac");
    type = "phone";
  }
  if (v.includes("signify") || v.includes("philips") || v.includes("hue")) {
    tags.push("hue-bridge"); type = "bridge";
  }
  if (v.includes("govee") || v.includes("espressif")) {
    tags.push("govee-candidate"); type = "smart-light";
  }
  if (v.includes("lifx") || v.includes("lifi")) {
    tags.push("lifx"); type = "smart-light";
  }
  if (v.includes("ge lighting") || v.includes("cync")) {
    tags.push("ge-cync"); type = "smart-light";
  }
  if (v.includes("tuya")) { tags.push("tuya"); type = "iot"; }
  if (v.includes("wyze")) { tags.push("wyze"); type = "iot"; }
  if (v.includes("google") || v.includes("chromecast") || v.includes("nest")) {
    tags.push("google-home"); type = "speaker";
  }
  if (v.includes("amazon") || v.includes("echo") || v.includes("alexa")) {
    tags.push("alexa"); type = "speaker";
  }
  if (v.includes("apple")) { tags.push("apple"); type = "phone"; }
  if (v.includes("arris") || v.includes("at&t") || v.includes("router")) {
    tags.push("router"); type = "router";
  }
  if (v.includes("western digital")) { tags.push("nas"); type = "nas"; }
  if (v.includes("hp") || v.includes("hewlett")) { tags.push("printer"); type = "printer"; }
  if (v.includes("asrock")) { tags.push("pc"); type = "computer"; }
  if (v.includes("fn-link")) { tags.push("wifi-module"); type = "iot"; }
  // Port-based classification overrides
  if (openPorts.includes(4003)) { tags.push("govee-lan"); type = "smart-light"; }
  if (openPorts.includes(8008)) { tags.push("chromecast"); type = "speaker"; }
  if (openPorts.includes(8443) && tags.includes("hue-bridge")) { tags.push("hue-api"); }
  if (openPorts.includes(11434)) { tags.push("ollama"); type = "computer"; }
  if (openPorts.includes(6333)) { tags.push("qdrant"); type = "computer"; }
  if (openPorts.includes(9197)) { tags.push("alexa-api"); type = "speaker"; }

  return { type, tags };
}

// ── Hostname resolution (reverse DNS on Windows) ───

function resolveHostnames(ips: string[]): Map<string, string> {
  const hostnames = new Map<string, string>();
  try {
    for (const ip of ips) {
      try {
        const output = execSync(`nslookup ${ip} 2>nul`, {
          encoding: "utf8",
          timeout: 3000,
          shell: "cmd.exe",
        });
        const nameMatch = output.match(/Name:\s+(\S+)/);
        if (nameMatch && !nameMatch[1].includes("in-addr.arpa")) {
          hostnames.set(ip, nameMatch[1]);
        }
      } catch { /* timeout or no reverse DNS */ }
    }
  } catch { /* batch failure */ }
  return hostnames;
}
// ── ARP table parsing (Windows) ────────────────────────

function parseArpTable(): Array<{ ip: string; mac: string }> {
  try {
    const output = execSync("arp -a", { encoding: "utf8", timeout: 10_000 });
    const entries: Array<{ ip: string; mac: string }> = [];
    for (const line of output.split(/\r?\n/)) {
      const match = line.match(/^\s*(192\.168\.\d+\.\d+)\s+([0-9a-f-]{17})\s+dynamic/i);
      if (match) {
        entries.push({ ip: match[1], mac: match[2].toLowerCase() });
      }
    }
    return entries;
  } catch {
    return [];
  }
}

// ── Ping sweep to populate ARP cache ───────────────────

async function pingSweep(subnet: string): Promise<void> {
  const base = subnet.replace(/\.\d+$/, "");
  const batchSize = 32;
  for (let start = 1; start < 255; start += batchSize) {
    const cmds: string[] = [];
    for (let i = start; i < Math.min(start + batchSize, 255); i++) {
      cmds.push(`ping -n 1 -w 200 ${base}.${i}`);
    }    try {
      const batch = cmds.map((c) => `start /B ${c} >nul 2>nul`).join(" & ");
      execSync(batch, { encoding: "utf8", timeout: 15_000, shell: "cmd.exe" });
    } catch { /* timeouts are expected for offline hosts */ }
  }
  await new Promise((r) => setTimeout(r, 2000));
}

// ── TCP port probe ─────────────────────────────────────

const PROBE_PORTS = [80, 443, 4003, 8008, 8443, 9197, 11434, 6333];

async function probePort(ip: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((res) => {
    const socket = createConnection({ host: ip, port, timeout: timeoutMs });
    socket.on("connect", () => { socket.destroy(); res(true); });
    socket.on("timeout", () => { socket.destroy(); res(false); });
    socket.on("error", () => { socket.destroy(); res(false); });
  });
}

async function probeHost(ip: string): Promise<number[]> {
  const results = await Promise.all(
    PROBE_PORTS.map(async (port) => ({ port, open: await probePort(ip, port) }))
  );
  return results.filter((r) => r.open).map((r) => r.port);
}
// ── Govee LAN discovery (UDP multicast) ────────────────

async function discoverGoveeLAN(): Promise<Array<{ ip: string; model: string; device: string }>> {
  return new Promise((resolve) => {
    const devices: Array<{ ip: string; model: string; device: string }> = [];
    const socket = createUdpSocket({ type: "udp4", reuseAddr: true });

    socket.on("message", (msg, rinfo) => {
      try {
        const data = JSON.parse(msg.toString());
        if (data.msg?.cmd === "scan" && data.msg?.data) {
          devices.push({
            ip: data.msg.data.ip ?? rinfo.address,
            model: data.msg.data.sku ?? "unknown",
            device: data.msg.data.device ?? rinfo.address,
          });
        }
      } catch { /* not JSON or wrong format */ }
    });
    socket.on("error", () => { /* bind failures on Windows are common */ });

    try {
      socket.bind(4002, () => {
        const scanMsg = JSON.stringify({ msg: { cmd: "scan", data: { account_topic: "reserve" } } });
        socket.setBroadcast(true);
        socket.send(scanMsg, 0, scanMsg.length, 4001, "239.255.255.250");
        socket.send(scanMsg, 0, scanMsg.length, 4001, "255.255.255.255");
      });
    } catch { /* fallthrough */ }

    setTimeout(() => { try { socket.close(); } catch {} resolve(devices); }, 3000);
  });
}
// ── Persistent registry ────────────────────────────────

const REGISTRY_PATH = resolve(config.cacheDir ?? "D:/ai-cache", "network-devices.json");

function loadRegistry(): NetworkDevice[] {
  try {
    if (existsSync(REGISTRY_PATH)) {
      return JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
    }
  } catch {}
  return [];
}

function saveRegistry(devices: NetworkDevice[]): void {
  writeFileSync(REGISTRY_PATH, JSON.stringify(devices, null, 2));
}

// ── Main scan function ─────────────────────────────────

export async function scanNetwork(options?: { skipPingSweep?: boolean }): Promise<ScanResult> {
  const startTime = Date.now();
  const subnet = "192.168.1.0/24";

  console.log("[network-scanner] starting scan...");

  if (!options?.skipPingSweep) {
    console.log("[network-scanner] ping sweep...");
    await pingSweep("192.168.1.0");
  }
  const arpEntries = parseArpTable();
  console.log(`[network-scanner] ARP: ${arpEntries.length} hosts`);

  const [goveeDevices, ...portResults] = await Promise.all([
    discoverGoveeLAN(),
    ...arpEntries.map((e) => probeHost(e.ip)),
  ]);

  if (goveeDevices.length > 0) {
    console.log(`[network-scanner] Govee LAN: found ${goveeDevices.length} devices`);
  }

  // Phase 4: Hostname resolution for non-randomized MACs without hostnames
  const registry = loadRegistry();
  const ipsNeedingHostname = arpEntries
    .filter((e) => {
      const existing = registry.find((r) => r.mac === e.mac);
      return !existing?.hostname && !isRandomizedMac(e.mac);
    })
    .map((e) => e.ip);

  let hostnames = new Map<string, string>();
  if (ipsNeedingHostname.length > 0) {
    console.log(`[network-scanner] resolving hostnames for ${ipsNeedingHostname.length} IPs...`);
    hostnames = resolveHostnames(ipsNeedingHostname);
    if (hostnames.size > 0) {
      console.log(`[network-scanner] resolved ${hostnames.size} hostnames`);
    }
  }
  // Phase 5: Build device records
  const now = new Date().toISOString();
  const hosts: NetworkDevice[] = [];

  for (let i = 0; i < arpEntries.length; i++) {
    const { ip, mac } = arpEntries[i];
    const openPorts = portResults[i];
    const vendor = lookupVendor(mac);
    const { type, tags } = classifyDevice(vendor, openPorts, mac);

    const goveeMatch = goveeDevices.find((g) => g.ip === ip);
    if (goveeMatch) {
      tags.push("govee-lan", `govee-model:${goveeMatch.model}`);
    }

    const existing = registry.find((r) => r.mac === mac);
    const hostname = hostnames.get(ip) ?? existing?.hostname;

    hosts.push({
      ip, mac, vendor, openPorts,
      deviceType: type,
      tags: [...new Set([...(existing?.tags ?? []), ...tags])],
      hostname,
      firstSeen: existing?.firstSeen ?? now,
      lastSeen: now,
      online: true,
    });
  }
  // Mark previously-seen devices as offline if not in current scan
  for (const prev of registry) {
    if (!hosts.find((h) => h.mac === prev.mac)) {
      hosts.push({ ...prev, online: false, lastSeen: prev.lastSeen });
    }
  }

  saveRegistry(hosts);

  const duration = Date.now() - startTime;
  const onlineCount = hosts.filter((h) => h.online).length;
  const identifiedCount = hosts.filter((h) => h.vendor !== "Unknown" && h.vendor !== "Randomized (Private)").length;
  console.log(`[network-scanner] done: ${onlineCount} online, ${identifiedCount} identified, ${hosts.length} total (${duration}ms)`);

  broadcast("home:network:scan" as any, {
    online: onlineCount,
    total: hosts.length,
    identified: identifiedCount,
    govee: goveeDevices.length,
  });

  return { subnet, scannedAt: now, duration, hosts };
}

// ── Getters for routes ─────────────────────────────────

export function getRegistry(): NetworkDevice[] {
  return loadRegistry();
}
export function getGoveeDevicesFromRegistry(): NetworkDevice[] {
  return loadRegistry().filter((d) =>
    d.tags.some((t) => t.startsWith("govee"))
  );
}

// ── Background scanner (periodic refresh) ──────────────

let scanInterval: ReturnType<typeof setInterval> | null = null;

export function startPeriodicScan(intervalMs = 300_000): void {
  if (scanInterval) return;
  console.log(`[network-scanner] periodic scan every ${intervalMs / 1000}s`);
  scanNetwork({ skipPingSweep: true }).catch((e) =>
    console.warn("[network-scanner] initial scan failed:", e.message)
  );
  scanInterval = setInterval(() => {
    scanNetwork().catch((e) =>
      console.warn("[network-scanner] periodic scan failed:", e.message)
    );
  }, intervalMs);
}

export function stopPeriodicScan(): void {
  if (scanInterval) { clearInterval(scanInterval); scanInterval = null; }
}
