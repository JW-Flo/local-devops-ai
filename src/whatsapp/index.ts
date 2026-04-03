import type { WASocket } from "@whiskeysockets/baileys";
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidGroup,
} from "@whiskeysockets/baileys";
import type { Router } from "express";
import express from "express";
import { config } from "../config.js";
import { callBedrock } from "../bedrock.js";

// ── Module State ──

let socket: WASocket | null = null;
let isConnecting = false;
const connectionStartTime = Date.now();
let messagesReceived = 0;
let messagesSent = 0;

// ── Config Reading ──

function getWhatsAppConfig() {
  const enabled = process.env.WHATSAPP_ENABLED === "1";
  const credsPath = process.env.WHATSAPP_CREDS_PATH ?? "D:/openclaw/credentials/whatsapp/default";
  const allowlistRaw = process.env.WHATSAPP_ALLOWLIST ?? "+17064612998";
  const allowlist = allowlistRaw.split(",").map((n) => n.trim()).filter(Boolean);
  return { enabled, credsPath, allowlist };
}

// ── Baileys Connection ──

async function initializeSocket(): Promise<WASocket> {
  if (socket && socket.user) return socket;
  if (isConnecting) return new Promise((res) => { setTimeout(() => res(initializeSocket()), 500); });

  const cfg = getWhatsAppConfig();
  isConnecting = true;

  const { state, saveCreds } = await useMultiFileAuthState(cfg.credsPath);
  const { version } = await fetchLatestBaileysVersion();

  socket = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true,
    generateHighQualityLinkPreview: true,
    shouldIgnoreJid: (jid) => isJidGroup(jid),
  });

  socket.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("[whatsapp] QR code generated — scan to authenticate");
    }

    if (connection === "connecting") {
      console.log("[whatsapp] Establishing connection...");
    }

    if (connection === "open") {
      console.log(`[whatsapp] Connected as ${socket?.user?.name}`);
      isConnecting = false;
    }

    if (connection === "close") {
      const code = (lastDisconnect?.error as any)?.output?.statusCode;
      const reason = DisconnectReason[code];
      const canReconnect = code !== DisconnectReason.loggedOut;

      console.log(`[whatsapp] Disconnected: ${reason} (code=${code})`);

      if (canReconnect) {
        console.log("[whatsapp] Auto-reconnecting...");
        setTimeout(() => {
          socket = null;
          isConnecting = false;
        }, 3000);
      } else {
        console.log("[whatsapp] Logged out — manual re-authentication required");
        socket = null;
      }
    }
  });

  socket.ev.on("creds.update", saveCreds);

  socket.ev.on("messages.upsert", async (m) => {
    for (const msg of m.messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const sender = msg.key.remoteJid ?? "";
      const isGroup = isJidGroup(sender);
      if (isGroup) continue;

      const cfg = getWhatsAppConfig();
      const senderClean = sender.split("@")[0];
      const isAllowed = cfg.allowlist.some((n) => senderClean.endsWith(n.replace(/^\+/, "")));
      if (!isAllowed) {
        console.log(`[whatsapp] Filtered message from ${senderClean} (not in allowlist)`);
        continue;
      }

      const text = msg.message.conversation ?? msg.message.extendedTextMessage?.text ?? "";
      if (!text) continue;

      messagesReceived++;
      console.log(`[whatsapp] Received from ${senderClean}: "${text}"`);

      try {
        const systemPrompt =
          "You are a helpful AI assistant responding via WhatsApp. " +
          "Be concise — WhatsApp messages should be short and direct. " +
          "You can help with: controlling home devices, checking market agent status, and general questions.";
        const response = await callBedrock(systemPrompt, text, { temp: 0.7, maxTokens: 256 });

        if (socket && socket.user) {
          await socket.sendMessage(sender, { text: response });
          messagesSent++;
          console.log(`[whatsapp] Sent to ${senderClean}: "${response}"`);
        }
      } catch (err) {
        console.error(`[whatsapp] Error processing message from ${senderClean}:`, err);
        if (socket && socket.user) {
          await socket.sendMessage(sender, {
            text: "Sorry, I encountered an error processing your message.",
          });
        }
      }
    }
  });

  return socket;
}

// ── Express Router ──

export function createWhatsAppRouter(): Router {
  const router = express.Router();

  // Status endpoint
  router.get("/status", (_req, res) => {
    const uptime = Date.now() - connectionStartTime;
    const phoneNumber = socket?.user?.id ?? "not connected";
    res.json({
      connected: socket?.user ? true : false,
      phoneNumber,
      uptime: Math.floor(uptime / 1000),
      messagesReceived,
      messagesSent,
    });
  });

  // Start connection
  router.post("/start", async (_req, res) => {
    try {
      const cfg = getWhatsAppConfig();
      if (!cfg.enabled) {
        return res.status(400).json({ status: "error", message: "WhatsApp is disabled (WHATSAPP_ENABLED=1)" });
      }

      const sock = await initializeSocket();
      res.json({
        status: "success",
        message: "WhatsApp connection initializing",
        connected: sock.user ? true : false,
        phoneNumber: sock.user?.id,
      });
    } catch (err) {
      console.error("[whatsapp] Failed to start:", err);
      res.status(500).json({ status: "error", message: (err as Error).message });
    }
  });

  // Stop connection
  router.post("/stop", async (_req, res) => {
    try {
      if (socket) {
        await socket.end();
        socket = null;
      }
      res.json({ status: "success", message: "WhatsApp disconnected" });
    } catch (err) {
      console.error("[whatsapp] Failed to stop:", err);
      res.status(500).json({ status: "error", message: (err as Error).message });
    }
  });

  // Send message (testing)
  router.post("/send", async (req, res) => {
    const { to, text } = req.body;
    if (!to || !text) {
      return res.status(400).json({ status: "error", message: "to and text required" });
    }

    try {
      const sock = socket || (await initializeSocket());
      if (!sock.user) {
        return res.status(500).json({ status: "error", message: "Not connected" });
      }

      const recipient = to.includes("@") ? to : `${to}@s.whatsapp.net`;
      await sock.sendMessage(recipient, { text });
      messagesSent++;

      res.json({ status: "success", message: "Message sent", to, text });
    } catch (err) {
      console.error("[whatsapp] Failed to send:", err);
      res.status(500).json({ status: "error", message: (err as Error).message });
    }
  });

  return router;
}
