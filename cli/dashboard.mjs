#!/usr/bin/env node
/**
 * Market Agent — Terminal Dashboard
 * Real-time TUI for monitoring the weather arbitrage bot
 * 
 * Usage: node cli/dashboard.mjs [--host http://127.0.0.1:4123]
 */

import blessed from "blessed";
import contrib from "blessed-contrib";

const HOST = process.argv.find(a => a.startsWith("--host="))?.split("=")[1]
  ?? process.argv[process.argv.indexOf("--host") + 1]
  ?? "http://127.0.0.1:4123";

const POLL_MS = 3000;
const FORECAST_POLL_MS = 30000;

// ── Helpers ──────────────────────────────────────────────────────────
async function api(path) {
  const r = await fetch(`${HOST}/market${path}`);
  return r.json();
}

function ts() {
  return new Date().toLocaleTimeString("en-US", { hour12: false });
}

function dollarFmt(n) {
  return "$" + Number(n).toFixed(2);
}

function pctFmt(n) {
  return (Number(n) * 100).toFixed(1) + "%";
}

function sparkline(arr, width = 20) {
  if (!arr.length) return "";
  const chars = "▁▂▃▄▅▆▇█";
  const min = Math.min(...arr);
  const max = Math.max(...arr);
  const range = max - min || 1;
  const recent = arr.slice(-width);
  return recent.map(v => chars[Math.min(7, Math.floor(((v - min) / range) * 7))]).join("");
}

// ── State ────────────────────────────────────────────────────────────
let status = {};
let forecasts = [];
let signals = [];
let positions = [];
let eventLog = [];
let bankrollHistory = [];
let signalCountHistory = [];
let lastError = null;

// ── Screen Setup ─────────────────────────────────────────────────────
const screen = blessed.screen({
  smartCSR: true,
  title: "Market Agent Dashboard",
  fullUnicode: true,
});

const grid = new contrib.grid({ rows: 12, cols: 12, screen });

// ── Header ───────────────────────────────────────────────────────────
const header = grid.set(0, 0, 1, 12, blessed.box, {
  content: "",
  tags: true,
  style: { fg: "white", bg: "black" },
  padding: { left: 1 },
});

function updateHeader() {
  const running = status.running ? "{green-fg}● RUNNING{/}" : "{red-fg}● STOPPED{/}";
  const mode = status.dryRun ? "{yellow-fg}DRY RUN{/}" : "{red-fg}LIVE{/}";
  const ws = status.wsConnected ? "{green-fg}WS ●{/}" : "{red-fg}WS ○{/}";
  const bankroll = dollarFmt(status.bankroll ?? 0);
  const markets = status.marketCount ?? 0;
  const sigs = status.signals ?? 0;
  header.setContent(
    `{bold} ⚡ MARKET AGENT{/}  ${running}  ${mode}  ${ws}  ` +
    `{cyan-fg}${bankroll}{/}  {white-fg}${markets} mkts{/}  ` +
    `{magenta-fg}${sigs} sigs{/}  {gray-fg}${ts()}{/}`
  );
}

// ── Safety Panel ─────────────────────────────────────────────────────
const safetyBox = grid.set(1, 0, 3, 4, blessed.box, {
  label: " {bold}Safety Guard{/} ",
  tags: true,
  border: { type: "line" },
  style: { border: { fg: "cyan" }, fg: "white" },
  padding: { left: 1, right: 1 },
});

function updateSafety() {
  const s = status.safety ?? {};
  const killed = s.killed ? "{red-fg}⛔ KILLED{/}" : "{green-fg}✓ Active{/}";
  const pnl = s.dailyPnL ?? 0;
  const pnlColor = pnl >= 0 ? "green" : "red";
  const exposure = dollarFmt(s.totalExposure ?? 0);
  const posCount = s.positionCount ?? 0;
  const cities = (s.activeCities ?? []).join(", ") || "none";
  
  safetyBox.setContent(
    `Status:    ${killed}\n` +
    `Daily P&L: {${pnlColor}-fg}${dollarFmt(pnl)}{/}\n` +
    `Exposure:  {yellow-fg}${exposure}{/}\n` +
    `Positions: ${posCount}\n` +
    `Cities:    ${cities}`
  );
}

// ── Bankroll Sparkline ───────────────────────────────────────────────
const bankrollBox = grid.set(1, 4, 3, 4, blessed.box, {
  label: " {bold}Bankroll{/} ",
  tags: true,
  border: { type: "line" },
  style: { border: { fg: "green" }, fg: "white" },
  padding: { left: 1, right: 1 },
});

function updateBankroll() {
  const current = dollarFmt(status.bankroll ?? 0);
  const spark = sparkline(bankrollHistory, 30);
  const high = bankrollHistory.length ? dollarFmt(Math.max(...bankrollHistory)) : "--";
  const low = bankrollHistory.length ? dollarFmt(Math.min(...bankrollHistory)) : "--";
  
  bankrollBox.setContent(
    `{bold}{cyan-fg}${current}{/}\n\n` +
    `{green-fg}${spark}{/}\n\n` +
    `High: {green-fg}${high}{/}  Low: {red-fg}${low}{/}`
  );
}

// ── Connection Info ──────────────────────────────────────────────────
const connBox = grid.set(1, 8, 3, 4, blessed.box, {
  label: " {bold}Connection{/} ",
  tags: true,
  border: { type: "line" },
  style: { border: { fg: "blue" }, fg: "white" },
  padding: { left: 1, right: 1 },
});

function updateConnection() {
  const ws = status.wsConnected ? "{green-fg}● Connected{/}" : "{red-fg}○ Disconnected{/}";
  const err = lastError ? `{red-fg}${lastError}{/}` : "{green-fg}No errors{/}";
  const sigSpark = sparkline(signalCountHistory, 30);
  
  connBox.setContent(
    `Gateway: {cyan-fg}${HOST}{/}\n` +
    `WS Feed: ${ws}\n` +
    `Markets: {white-fg}${status.marketCount ?? 0}{/}\n` +
    `Signals: {magenta-fg}${sigSpark}{/}\n` +
    `Last Err: ${err}`
  );
}

// ── Forecasts Table ──────────────────────────────────────────────────
const forecastTable = grid.set(4, 0, 4, 6, contrib.table, {
  label: " {bold}NOAA Forecasts{/} ",
  tags: true,
  keys: true,
  fg: "white",
  selectedFg: "black",
  selectedBg: "cyan",
  columnSpacing: 2,
  columnWidth: [10, 12, 8, 14],
  border: { type: "line" },
  style: { border: { fg: "yellow" }, header: { fg: "cyan", bold: true } },
});

function updateForecasts() {
  const headers = ["City", "Date", "High°F", "Series"];
  const rows = forecasts.map(f => {
    const tempColor = f.highF >= 80 ? "🔴" : f.highF >= 60 ? "🟡" : "🔵";
    return [f.city, f.targetDate, `${tempColor} ${f.highF}`, f.seriesTicker];
  });
  forecastTable.setData({ headers, data: rows });
}

// ── Signals Table ────────────────────────────────────────────────────
const signalTable = grid.set(4, 6, 4, 6, contrib.table, {
  label: " {bold}Trading Signals{/} ",
  tags: true,
  keys: true,
  fg: "white",
  selectedFg: "black",
  selectedBg: "magenta",
  columnSpacing: 2,
  columnWidth: [18, 8, 8, 8, 6],
  border: { type: "line" },
  style: { border: { fg: "magenta" }, header: { fg: "magenta", bold: true } },
});

function updateSignals() {
  const headers = ["Ticker", "NOAA%", "Mkt$", "Edge", "Qty"];
  if (!signals.length) {
    signalTable.setData({ headers, data: [["Scanning...", "--", "--", "--", "--"]] });
    return;
  }
  const rows = signals.map(s => [
    s.ticker ?? s.market_ticker ?? "--",
    pctFmt(s.noaaProbability ?? s.probability ?? 0),
    dollarFmt(s.marketPrice ?? 0),
    pctFmt(s.edge ?? 0),
    String(s.recommendedContracts ?? s.contracts ?? 0),
  ]);
  signalTable.setData({ headers, data: rows });
}

// ── Event Log ────────────────────────────────────────────────────────
const logBox = grid.set(8, 0, 4, 12, contrib.log, {
  label: " {bold}Event Log{/} ",
  tags: true,
  fg: "green",
  border: { type: "line" },
  style: { border: { fg: "green" } },
  bufferLength: 200,
});

function colorEvent(type) {
  const colors = {
    bot_started: "{green-fg}",
    forecast_update: "{yellow-fg}",
    signal_detected: "{magenta-fg}",
    trade_simulated: "{cyan-fg}",
    trade_executed: "{red-fg}",
    ws_connected: "{green-fg}",
    ws_disconnected: "{red-fg}",
    market_refresh: "{blue-fg}",
    error: "{red-fg}",
  };
  return colors[type] ?? "{white-fg}";
}

function pushEvent(type, detail) {
  const color = colorEvent(type);
  const line = `{gray-fg}${ts()}{/} ${color}[${type}]{/} ${detail}`;
  eventLog.push(line);
  logBox.log(line);
}

// ── Data Fetchers ────────────────────────────────────────────────────
async function pollStatus() {
  try {
    status = await api("/status");
    bankrollHistory.push(status.bankroll ?? 0);
    if (bankrollHistory.length > 100) bankrollHistory.shift();
    signalCountHistory.push(status.signals ?? 0);
    if (signalCountHistory.length > 100) signalCountHistory.shift();
    lastError = null;
  } catch (e) {
    lastError = e.message?.slice(0, 40);
    pushEvent("error", `Status poll failed: ${e.message}`);
  }
}

async function pollForecasts() {
  try {
    const data = await api("/forecasts");
    forecasts = data.forecasts ?? [];
  } catch (e) {
    pushEvent("error", `Forecast poll failed: ${e.message}`);
  }
}

async function pollSignals() {
  try {
    const data = await api("/signals");
    const prev = signals.length;
    signals = data.signals ?? [];
    if (signals.length > prev) {
      for (const s of signals.slice(prev)) {
        pushEvent("signal_detected",
          `${s.ticker ?? s.market_ticker} edge=${pctFmt(s.edge ?? 0)} qty=${s.recommendedContracts ?? 0}`);
      }
    }
  } catch (e) {
    pushEvent("error", `Signal poll failed: ${e.message}`);
  }
}

async function pollEvents() {
  try {
    const r = await fetch(`${HOST}/market/status`);
    // If we have positions endpoint
    const posData = await api("/positions").catch(() => ({ positions: [] }));
    positions = posData.positions ?? [];
  } catch (_) {}
}

// ── SSE Stream (real-time events) ────────────────────────────────────
async function connectSSE() {
  try {
    const r = await fetch(`${HOST}/events`, { signal: AbortSignal.timeout(0x7FFFFFFF) });
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    
    pushEvent("ws_connected", "SSE stream connected");
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            const evt = JSON.parse(line.slice(6));
            if (evt.type?.startsWith("market:")) {
              pushEvent(evt.type.replace("market:", ""), 
                JSON.stringify(evt.payload ?? {}).slice(0, 80));
            }
          } catch (_) {}
        }
      }
    }
  } catch (e) {
    if (!e.message?.includes("abort")) {
      pushEvent("ws_disconnected", `SSE: ${e.message}`);
      setTimeout(connectSSE, 5000);
    }
  }
}

// ── Render Loop ──────────────────────────────────────────────────────
function render() {
  updateHeader();
  updateSafety();
  updateBankroll();
  updateConnection();
  updateForecasts();
  updateSignals();
  screen.render();
}

// ── Key Bindings ─────────────────────────────────────────────────────
screen.key(["escape", "q", "C-c"], () => process.exit(0));

screen.key(["s"], async () => {
  pushEvent("bot_started", "Sending /start...");
  try {
    await fetch(`${HOST}/market/start`, { method: "POST" });
    pushEvent("bot_started", "Agent started");
  } catch (e) {
    pushEvent("error", `Start failed: ${e.message}`);
  }
});

screen.key(["x"], async () => {
  pushEvent("ws_disconnected", "Sending /stop...");
  try {
    await fetch(`${HOST}/market/stop`, { method: "POST" });
    pushEvent("ws_disconnected", "Agent stopped");
  } catch (e) {
    pushEvent("error", `Stop failed: ${e.message}`);
  }
});

screen.key(["k"], async () => {
  pushEvent("error", "Sending /kill...");
  try {
    await fetch(`${HOST}/market/kill`, { method: "POST" });
    pushEvent("error", "Kill switch engaged");
  } catch (e) {
    pushEvent("error", `Kill failed: ${e.message}`);
  }
});

screen.key(["r"], async () => {
  pushEvent("market_refresh", "Manual refresh...");
  await Promise.all([pollStatus(), pollForecasts(), pollSignals()]);
  render();
});

// ── Startup ──────────────────────────────────────────────────────────
pushEvent("bot_started", `Dashboard connecting to ${HOST}`);
pushEvent("bot_started", "Keys: [s]tart  [x]stop  [k]ill  [r]efresh  [q]uit");

await pollStatus();
await pollForecasts();
await pollSignals();
render();

// Connect SSE for real-time events
connectSSE();

// Poll loops
setInterval(async () => { await pollStatus(); await pollSignals(); render(); }, POLL_MS);
setInterval(async () => { await pollForecasts(); render(); }, FORECAST_POLL_MS);
setInterval(render, 1000);

screen.render();
