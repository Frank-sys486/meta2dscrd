// bot.js (ESM)
// Features:
// - WebSocket server to talk to Chrome extension (no webhook, no Meta API)
// - Messenger -> Discord: text + files/images (as base64 -> Discord attachments)
// - Discord -> Messenger: text + files/images (download -> base64 -> WS to extension)

import "dotenv/config";
import { Client, GatewayIntentBits, Partials } from "discord.js";
import WebSocket, { WebSocketServer } from "ws";
import fetch from "node-fetch";
import { randomUUID } from "crypto";

const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const WS_PORT = Number(process.env.WS_PORT || 8080);

if (!TOKEN || !GUILD_ID) {
  console.error("[ENV] Missing DISCORD_TOKEN or GUILD_ID in .env");
  process.exit(1);
}

// --- Discord client ---
const intents = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages
];
if (String(process.env.ENABLE_MESSAGE_CONTENT).toLowerCase() === "true") {
  intents.push(GatewayIntentBits.MessageContent);
}

const client = new Client({
  intents,
  partials: [Partials.Channel, Partials.Message]
});

// --- WebSocket server to talk to the extension ---
const wss = new WebSocketServer({ port: WS_PORT });
let extensionSocket = null;

wss.on("connection", (ws) => {
  console.log("[WS] Extension connected");
  extensionSocket = ws;

  ws.on("message", async (msgBuf) => {
    try {
      const msg = JSON.parse(msgBuf.toString());

      if (msg.kind === "ping") {
        ws.send(JSON.stringify({ kind: "pong" }));
        return;
      }

      // Handle Messenger -> Discord
      if (msg.direction === "messenger_to_discord") {
        const guild = await client.guilds.fetch(GUILD_ID);
        const channelName = sanitizeChannelName(msg.sender || msg.recipient || "unknown");

        let chan = guild.channels.cache.find((c) => c.name === channelName);
        if (!chan) {
          chan = await guild.channels.create({
            name: channelName,
            type: 0 // text
          });
        }

        if (msg.type === "text") {
          await chan.send({ content: msg.content || "" });
        } else if (msg.type === "file" && Array.isArray(msg.files)) {
          const files = msg.files.map((f) => ({
            attachment: Buffer.from(f.base64, "base64"),
            name: f.name || `file-${Date.now()}`
          }));
          await chan.send({ content: msg.content || "", files });
        }
      }
    } catch (e) {
      console.error("[WS] Incoming error:", e);
    }
  });

  ws.on("close", () => {
    if (extensionSocket === ws) extensionSocket = null;
    console.log("[WS] Extension disconnected");
  });
});

// Discord -> Messenger
client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;
    if (!extensionSocket || extensionSocket.readyState !== WebSocket.OPEN) return;

    const channelName = message.channel?.name;
    if (!channelName) return;

    const basePayload = {
      direction: "discord_to_messenger",
      recipient: channelName
    };

    // Collect attachments
    const files = [];
    for (const att of message.attachments.values()) {
      try {
        const res = await fetch(att.url);
        const arr = Buffer.from(await res.arrayBuffer());
        files.push({
          name: att.name || `file-${randomUUID()}`,
          mime: att.contentType || "application/octet-stream",
          base64: arr.toString("base64")
        });
      } catch (e) {
        console.error("[DL] Failed to fetch attachment:", e);
      }
    }

    if (files.length === 0) {
      extensionSocket.send(
        JSON.stringify({
          ...basePayload,
          type: "text",
          content: message.content || ""
        })
      );
    } else {
      extensionSocket.send(
        JSON.stringify({
          ...basePayload,
          type: "file",
          content: message.content || "",
          files
        })
      );
    }
  } catch (e) {
    console.error("[Discord->Messenger] Error:", e);
  }
});

client.once("clientReady", () => {
  console.log(`[Discord] Logged in as ${client.user.tag}`);
  console.log(`[Discord] MessageContent intent: ${intents.includes(GatewayIntentBits.MessageContent)}`);
  console.log(`[WS] Listening on :${WS_PORT}`);
});

client.login(TOKEN);

// Helpers
function sanitizeChannelName(name) {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 90) || "unknown"
  );
}
