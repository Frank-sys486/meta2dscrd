// ==UserScript==
// @name         Messenger ↔ Discord Bridge
// @namespace    https://github.com/user/meta2dscrd
// @version      1.0.0
// @description  Forwards Messenger messages to a Discord bot over WebSocket and mirrors Discord replies back into Messenger.
// @author       meta2dscrd
// @match        https://www.messenger.com/*
// @grant        GM_xmlhttpRequest
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  if (window.__M2D_BRIDGE_INITIALIZED__) {
    return;
  }
  window.__M2D_BRIDGE_INITIALIZED__ = true;

  const WS_URL = window.localStorage.getItem("m2d-ws-url") || "ws://localhost:8080";
  let ws;
  const pending = [];
  let reconnectTimer;
  let statusTimer;
  let statusNode;



  function log(...args) {
    console.log("[Messenger↔Discord]", ...args);
  }

  function warn(...args) {
    console.warn("[Messenger↔Discord]", ...args);
  }

  function ensureStatusNode() {
    if (statusNode && statusNode.isConnected) return statusNode;
    statusNode = document.createElement("div");
    statusNode.id = "m2d-status-banner";
    Object.assign(statusNode.style, {
      position: "fixed",
      zIndex: 2147483647,
      right: "16px",
      bottom: "16px",
      padding: "10px 14px",
      borderRadius: "6px",
      fontSize: "13px",
      fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      color: "#fff",
      background: "#1d1f21",
      boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
      opacity: "0",
      transition: "opacity 0.2s ease-in-out"
    });
    document.body.appendChild(statusNode);
    return statusNode;
  }

  function showStatus(message, tone = "info", linger = 2000) {
    const el = ensureStatusNode();
    el.textContent = message;
    el.style.background = tone === "connected" ? "#2d7a46" : tone === "error" ? "#a83232" : "#1d1f21";
    clearTimeout(statusTimer);
    requestAnimationFrame(() => {
      el.style.opacity = "1";
      statusTimer = setTimeout(() => {
        el.style.opacity = "0";
      }, linger);
    });
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectWS, 2000);
  }

  function connectWS() {
    try {
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        return;
      }
      ws?.close?.();
      ws = new WebSocket(WS_URL);
    } catch (err) {
      warn("Failed to create WebSocket", err);
      scheduleReconnect();
      return;
    }

    ws.addEventListener("open", () => {
      log("Connected to Discord bot");
      showStatus("Messenger ↔ Discord connected", "connected", 3000);
      sendRaw({ kind: "ping" });
      flushPending();
    });

    ws.addEventListener("close", () => {
      warn("WebSocket closed; retrying soon");
      showStatus("Messenger ↔ Discord reconnecting…", "error", 2500);
      scheduleReconnect();
    });

    ws.addEventListener("error", (event) => {
      warn("WebSocket error", event);
      showStatus("Messenger ↔ Discord error", "error", 2500);
    });

    ws.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.direction === "discord_to_messenger") {
          handleIncomingDiscordMessage(data);
        }
      } catch (err) {
        warn("Failed to parse message", err);
      }
    });
  }

  function flushPending() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    while (pending.length) {
      const payload = pending.shift();
      try {
        ws.send(payload);
      } catch (err) {
        warn("Failed to flush payload", err);
        pending.unshift(payload);
        break;
      }
    }
  }

  function sendRaw(obj) {
    const serialized = JSON.stringify(obj);
    log("Queueing payload", obj);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      pending.push(serialized);
      connectWS();
      return;
    }
    try {
      ws.send(serialized);
      if (obj.direction === "messenger_to_discord") {
        showStatus("Sent to Discord", "info", 1800);
      }
    } catch (err) {
      warn("Failed to send payload", err);
      pending.unshift(serialized);
      scheduleReconnect();
    }
  }

  function sanitizeChannelName(name) {
    return (name || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 90) || "unknown";
  }

  function handleIncomingDiscordMessage(payload) {
    const active = resolveConversation();
    if (!active) return;
    if (payload.recipient && sanitizeChannelName(active.sender) !== payload.recipient) {
      return; // Different conversation tab open
    }

    if (payload.type === "text") {
      sendTextToMessenger(payload.content || "");
    } else if (payload.type === "file") {
      sendFilesToMessenger(payload.files || [], payload.content || "");
    }
    showStatus("New message from Discord", "info", 2000);
  }

  function findComposer() {
    return document.querySelector('[contenteditable="true"][role="textbox"]');
  }

  function sendTextToMessenger(content) {
    const composer = findComposer();
    if (!composer) {
      warn("Composer not found for text");
      return;
    }

    composer.focus();
    document.execCommand("selectAll", false, null);
    document.execCommand("insertText", false, content);
    composer.dispatchEvent(new InputEvent("input", { bubbles: true }));
    composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
  }

  function sendFilesToMessenger(files, caption) {
    const composer = findComposer();
    if (!composer) {
      warn("Composer not found for files");
      return;
    }

    if (caption) {
      composer.focus();
      document.execCommand("insertText", false, caption);
      composer.dispatchEvent(new InputEvent("input", { bubbles: true }));
    }

    const dt = new DataTransfer();
    for (const file of files) {
      try {
        const bin = atob(file.base64 || "");
        const len = bin.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
        const blob = new Blob([bytes], { type: file.mime || "application/octet-stream" });
        const f = new File([blob], file.name || `file-${Date.now()}`);
        dt.items.add(f);
      } catch (err) {
        warn("Failed to reconstruct file", err);
      }
    }

    const rect = composer.getBoundingClientRect();
    const event = new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
      dataTransfer: dt,
      clientX: rect.left + 10,
      clientY: rect.top + 10
    });
    composer.dispatchEvent(event);

    setTimeout(() => {
      composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
    }, 400);
  }

  // Messenger → Discord
  const SEEN = new Set();

  function observeMessages() {
    const root = document.body;
    if (!root) return;

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          const rows = node.matches?.('[role="row"]') ? [node] : node.querySelectorAll?.('[role="row"]');
          if (!rows) continue;
          rows.forEach((row) => parseBubbleIfNew(row));
        }
      }
    });

    observer.observe(root, { childList: true, subtree: true });

    setTimeout(() => {
      document.querySelectorAll('[role="row"]').forEach(parseBubbleIfNew);
    }, 1500);
  }

  function resolveConversation() {
    const header = document.querySelector("h1, h2");
    const sender = (header?.innerText || "unknown").trim();
    return { sender };
  }

  function parseBubbleIfNew(bubble) {
    if (!(bubble instanceof HTMLElement)) return;
    const syntheticId = bubble.getAttribute("data-message-id") || bubble.outerHTML.slice(0, 400);
    if (SEEN.has(syntheticId)) return;
    SEEN.add(syntheticId);

    const conv = resolveConversation();
    const textContent = extractTextFromBubble(bubble);
    const filePromises = extractFilesFromBubble(bubble);

    Promise.all(filePromises)
      .then((files) => {
        const attachments = (files || []).filter(Boolean);
        if (attachments.length > 0) {
          sendRaw({
            direction: "messenger_to_discord",
            sender: conv.sender,
            type: "file",
            content: textContent || "",
            files: attachments
          });
        } else if (textContent) {
          sendRaw({
            direction: "messenger_to_discord",
            sender: conv.sender,
            type: "text",
            content: textContent
          });
        } else {
          const fallbackText = fallbackBubbleText(bubble);
          if (fallbackText) {
            sendRaw({
              direction: "messenger_to_discord",
              sender: conv.sender,
              type: "text",
              content: fallbackText
            });
          }
        }
      })
      .catch((err) => warn("Failed to parse bubble", err));
  }

  function extractTextFromBubble(bubble) {
    const blocks = bubble.querySelectorAll('div[dir="auto"]:not([aria-hidden="true"])');
    const parts = [];
    blocks.forEach((el) => {
      if (el.querySelector("time, [data-testid*='timestamp']")) return;
      const t = (el.innerText || "").trim();
      if (t) parts.push(t);
    });
    return parts.join("\n").trim();
  }

  function fallbackBubbleText(bubble) {
    return (bubble.innerText || "").trim();
  }

  function fetchToBase64(url) {
    if (typeof GM_xmlhttpRequest === "function") {
      return gmRequestToBase64(url);
    }
    return fetch(url)
      .then((res) => res.arrayBuffer().then((buf) => ({
        base64: arrayBufferToBase64(buf),
        mime: res.headers.get("content-type") || ""
      })));
  }

  function gmRequestToBase64(url) {
    return new Promise((resolve, reject) => {
      try {
        GM_xmlhttpRequest({
          method: "GET",
          url,
          responseType: "arraybuffer",
          onload: (response) => {
            if (response.status >= 200 && response.status < 300) {
              const buffer = response.response;
              if (!(buffer instanceof ArrayBuffer)) {
                reject(new Error("Unexpected response type"));
                return;
              }
              resolve({
                base64: arrayBufferToBase64(buffer),
                mime: response.responseHeaders?.match(/content-type:\s*([^;\n]+)/i)?.[1] || ""
              });
            } else {
              reject(new Error(`HTTP ${response.status}`));
            }
          },
          onerror: (err) => reject(err),
          ontimeout: () => reject(new Error("Request timed out"))
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  function arrayBufferToBase64(buf) {
    let binary = "";
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  function inferNameFromUrl(u, prefix) {
    try {
      const url = new URL(u);
      const file = (url.pathname.split("/").pop() || "").split("?")[0];
      if (file) return file;
    } catch (err) {
      // ignore
    }
    return `${prefix}-${Date.now()}`;
  }

  function imageToCanvasBase64(img) {
    return new Promise((resolve, reject) => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0);
        const base64 = canvas.toDataURL("image/png").split(",")[1];
        resolve({ base64, mime: "image/png" });
      } catch (err) {
        reject(err);
      }
    });
  }

  function findImgByUrl(url) {
    const imgs = Array.from(document.querySelectorAll("img"));
    return imgs.find((img) => (img.currentSrc || img.src) === url);
  }

  function fetchToBase64WithCanvasFallback(url) {
    return fetchToBase64(url).catch(async (err) => {
      const img = findImgByUrl(url);
      if (img) {
        try {
          return await imageToCanvasBase64(img);
        } catch (canvasErr) {
          warn("Canvas fallback failed", canvasErr);
        }
      }
      throw err;
    });
  }

  // Collect attachments with a canvas fallback for inline images
  function extractFilesFromBubble(bubble) {
    const promises = [];

    bubble.querySelectorAll("img").forEach((img) => {
      const src = img.currentSrc || img.src;
      if (!src) return;
      promises.push(
        fetchToBase64WithCanvasFallback(src)
          .then(({ base64, mime }) => ({
            name: inferNameFromUrl(src, "image"),
            mime: mime || "image/jpeg",
            base64
          }))
          .catch(() => null)
      );
    });

    bubble.querySelectorAll('a[href*="attachment"], a[download]').forEach((a) => {
      const href = a.href;
      if (!href) return;
      promises.push(
        fetchToBase64(href)
          .then(({ base64, mime }) => ({
            name: inferNameFromUrl(href, "file"),
            mime: mime || "application/octet-stream",
            base64
          }))
          .catch(() => null)
      );
    });

    return promises;
  }

  function bootstrap() {
    if (!/messenger\.com$/.test(location.hostname)) {
      return;
    }
    connectWS();
    observeMessages();
    window.addEventListener("focus", connectWS);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        connectWS();
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap, { once: true });
  } else {
    bootstrap();
  }
})();
