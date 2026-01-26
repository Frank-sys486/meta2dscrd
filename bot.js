import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  Events,
} from "discord.js";
import WebSocket, { WebSocketServer } from "ws";
import fetch from "node-fetch";
import { randomUUID } from "crypto";

// ---------- ENV ----------
function asBool(v, def = false) {
  if (v == null) return def;
  const s = String(v).trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "y";
}
function asInt(v, def = 0) {
  const n = Number(String(v || "").trim());
  return Number.isFinite(n) ? n : def;
}

const TOKEN = (process.env.DISCORD_TOKEN || "").trim();
const GUILD_ID = (process.env.GUILD_ID || "").trim();
const WS_PORT = asInt(process.env.WS_PORT, 8080);
const CATEGORY_ID = (process.env.DISCORD_CATEGORY_ID || "").trim() || null;
const DEBUG = asBool(process.env.DEBUG, false);
const DEDUP_ENABLED = asBool(process.env.DEDUP_ENABLED, true);

function log(...a) { if (DEBUG) console.log(...a); }
function warn(...a) { console.warn(...a); }
function err(...a) { console.error(...a); }

if (!TOKEN || !GUILD_ID) {
  err("[ENV] Missing DISCORD_TOKEN or GUILD_ID");
  process.exit(1);
}

// ---------- Discord client ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // enable in Developer Portal
  ],
  partials: [Partials.Channel, Partials.Message],
});

// ---------- WS server ----------
const wss = new WebSocketServer({ port: WS_PORT });
let extensionSocket = null;

// ---------- Helpers ----------
function normalizeChannelName(name) {
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

function normalizeContent(s) {
  return (s || "")
    .replace(/\r\n/g, "\n")
    .replace(/\s+/g, " ")
    .trim();
}

/** Fetch the current last message content in the channel (text only). */
async function getLastMessageContent(chan) {
  try {
    const msgs = await chan.messages.fetch({ limit: 1 });
    const last = msgs.first();
    if (!last) return null;
    // We only care about text content for this de-dup (your flow is text-only)
    return normalizeContent(last.content || "");
  } catch (e) {
    warn(`[DeDup] Could not fetch last message in #${chan.name}:`, e?.message || e);
    return null;
  }
}

/** Return true if incoming content equals the channel’s actual last message. */
async function isDuplicateAgainstDiscord(chan, incomingContent) {
  const incoming = normalizeContent(incomingContent);
  const last = await getLastMessageContent(chan);
  if (last == null) return false;       // nothing in channel yet
  if (incoming.length === 0) return false; // ignore empty comparisons
  return incoming === last;
}

// Channel cache
const channelCacheByName = new Map(); // name -> id

async function getOrCreateChannelByName(guild, normalizedName) {
  const cachedId = channelCacheByName.get(normalizedName);
  if (cachedId) {
    try {
      const c = await client.channels.fetch(cachedId);
      if (c?.type === ChannelType.GuildText && c.guild.id === guild.id) return c;
    } catch { /* stale */ }
  }

  let chan = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildText && c.name === normalizedName
  );

  if (!chan) {
    try {
      const fetched = await guild.channels.fetch();
      chan = fetched.find((c) => c?.type === ChannelType.GuildText && c?.name === normalizedName) || null;
    } catch {}
  }

  if (chan) {
    channelCacheByName.set(normalizedName, chan.id);
    return chan;
  }

  const data = { name: normalizedName, type: ChannelType.GuildText };
  if (CATEGORY_ID) data.parent = CATEGORY_ID;

  try {
    chan = await guild.channels.create(data);
    channelCacheByName.set(normalizedName, chan.id);
    console.log(`[Channel] Created #${normalizedName}${data.parent ? ` under ${data.parent}` : ""}`);
    return chan;
  } catch (e) {
    err("[Channel] Failed to create channel. Missing 'Manage Channels' or invalid category.");
    err("Details:", e?.message || e);
    return null;
  }
}

// ---------- WS handlers ----------
wss.on("connection", (ws) => {
  console.log("[WS] Extension connected");
  extensionSocket = ws;

  ws.on("message", async (msgBuf) => {
    let msg;
    try {
      msg = JSON.parse(msgBuf.toString());
    } catch (e) {
      return err("[WS] Invalid JSON from client:", e);
    }

    if (msg.kind === "ping") {
      return ws.send(JSON.stringify({ kind: "pong" }));
    }

    if (msg.direction === "messenger_to_discord") {
      try {
        const guild = await client.guilds.fetch(GUILD_ID);
        const rawName = (msg.channel_hint || msg.sender || msg.recipient || "unknown").trim();
        const channelName = normalizeChannelName(rawName);
        const debugForce = !!msg.debug_force;

        log(`[WS→Discord] incoming: raw="${rawName}" normalized="#${channelName}" type=${msg.type}${debugForce ? " (debug_force)" : ""}`);

        const chan = await getOrCreateChannelByName(guild, channelName);
        if (!chan) return;

        if (msg.type === "text") {
          const content = msg.content || "";

          // NEW: compare to the channel’s true last message
          if (DEDUP_ENABLED && !debugForce) {
            const dup = await isDuplicateAgainstDiscord(chan, content);
            if (dup) {
              log(`[DeDup] skipped (matches actual last message) in #${channelName}`);
              return;
            }
          }

          await chan.send({ content });
          log(`[Channel #${channelName}] posted text:`, content.slice(0, 120));
        } else if (msg.type === "file" && Array.isArray(msg.files)) {
          const files = msg.files.map((f) => ({
            attachment: Buffer.from(f.base64, "base64"),
            name: f.name || `file-${Date.now()}`,
          }));
          await chan.send({ content: msg.content || "", files });
          log(`[Channel #${channelName}] posted ${files.length} attachment(s).`);
        } else {
          warn("[WS] Unknown msg.type or missing files array:", msg.type);
        }
      } catch (e) {
        err("[WS handler] Error:", e);
      }
    }
  });

  ws.on("close", () => {
    if (extensionSocket === ws) extensionSocket = null;
    console.log("[WS] Extension disconnected");
  });
});

// ---------- Discord → Messenger (unchanged) ----------
client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;
    if (!extensionSocket || extensionSocket.readyState !== WebSocket.OPEN) return;

    const channelName = message.channel?.name;
    if (!channelName) return;

    const payloadBase = {
      direction: "discord_to_messenger",
      recipient: channelName,
    };

    const files = [];
    for (const att of message.attachments.values()) {
      try {
        const res = await fetch(att.url);
        const arr = Buffer.from(await res.arrayBuffer());
        files.push({
          name: att.name || `file-${randomUUID()}`,
          mime: att.contentType || "application/octet-stream",
          base64: arr.toString("base64"),
        });
      } catch (e) {
        err("[DL] Failed to fetch attachment:", e);
      }
    }

    if (files.length === 0) {
      extensionSocket.send(JSON.stringify({ ...payloadBase, type: "text", content: message.content || "" }));
      log(`[Discord→WS] forwarded text from #${channelName}`);
    } else {
      extensionSocket.send(JSON.stringify({ ...payloadBase, type: "file", content: message.content || "", files }));
      log(`[Discord→WS] forwarded files(${files.length}) from #${channelName}`);
    }
  } catch (e) {
    err("[Discord->Messenger] Error:", e);
  }
});

client.once(Events.ClientReady, async () => {
  console.log(`[Discord] Logged in as ${client.user.tag}`);
  try {
    const g = await client.guilds.fetch(GUILD_ID);
    console.log(`[Discord] Connected to guild: ${g.name} (${g.id})`);
  } catch (e) {
    err("[Discord] Failed to fetch guild. Check GUILD_ID and bot membership.", e);
  }
  if (CATEGORY_ID) {
    try {
      const cat = await client.channels.fetch(CATEGORY_ID);
      if (!cat || cat.type !== ChannelType.GuildCategory) {
        warn("[Discord] DISCORD_CATEGORY_ID is not a category; creating channels at root.");
      } else {
        log(`[Discord] Using category: ${cat.name} (${cat.id})`);
      }
    } catch (e) {
      warn("[Discord] Could not fetch DISCORD_CATEGORY_ID; creating channels at root.", e);
    }
  }
  console.log(`[WS] Listening on :${WS_PORT}`);
});

client.login(TOKEN);
