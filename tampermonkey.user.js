// ==UserScript==
// @name         Messenger → Discord (latest text only, grid-scoped, group author-aware)
// @namespace    meta2dscrd.latest.grid.author.group
// @version      1.5.0
// @description  Forward ONLY the latest text message from the open Messenger conversation to Discord via WS. Grid-scoped; supports group chats by reading <h5> author (You sent -> me). Includes your own messages, ignores media, thread-aware. Channels are created per conversation title.
// @match        https://www.messenger.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  // ---------------- Config ----------------
  const WS_URL = "ws://localhost:8080";
  const INITIAL_SEND_DELAY_MS = 600;   // wait after thread change to let DOM settle
  const MUTATION_DEBOUNCE_MS = 120;    // debounce DOM bursts
  const MAX_ROW_HTML_FINGERPRINT = 800;

  // -------------- WS (auto-retry) --------------
  let ws = null, wsConnected = false;
  function connectWS() {
    try {
      ws = new WebSocket(WS_URL);
      ws.onopen = () => { wsConnected = true; console.log("[TM][WS] connected"); try { ws.send(JSON.stringify({ kind: "ping" })); } catch {} };
      ws.onclose = () => { wsConnected = false; console.warn("[TM][WS] disconnected; retrying..."); setTimeout(connectWS, 2000); };
      ws.onerror = (e) => console.warn("[TM][WS] error", e);
    } catch (e) {
      console.warn("[TM][WS] connect error", e);
      setTimeout(connectWS, 2000);
    }
  }
  connectWS();

  // ---------------- Helpers ----------------
  const qs  = (sel, scope=document) => scope.querySelector(sel);
  const qsa = (sel, scope=document) => Array.from(scope.querySelectorAll(sel));
  const hash = (s) => { let h=0>>>0; for (let i=0;i<s.length;i++) h=(h*31 + s.charCodeAt(i))>>>0; return h.toString(16); };

  function getComposer() {
    return qs('[contenteditable="true"][role="textbox"]');
  }

  function getMessageGrid() {
    // e.g.: aria-label="Messages in conversation titled Conying Putot"
    // or:   aria-label="Messages in conversation with Justine Deluana"
    return qs('div[role="grid"][aria-label^="Messages in conversation"]');
  }

  function parseTitleFromAria(aria) {
    // Handle both patterns: "... with NAME" and "... titled NAME"
    // Trim any trailing whitespace
    if (!aria) return "";
    let m = aria.match(/\bwith\s+(.+)\s*$/i);
    if (m && m[1]) return m[1].trim();
    m = aria.match(/\btitled\s+(.+)\s*$/i);
    if (m && m[1]) return m[1].trim();
    return "";
  }

  function getConversationTitleSafe() {
    const grid = getMessageGrid();
    const aria = grid?.getAttribute("aria-label") || "";
    const fromAria = parseTitleFromAria(aria);
    if (fromAria) return fromAria;

    // Fallbacks (prefer h2, never h1 “Chats”)
    const h2s = qsa("h2");
    if (h2s.length === 1) return (h2s[0].innerText || "").trim();
    const comp = getComposer();
    if (comp && h2s.length) {
      const compAnc = new Set(); let p = comp;
      while (p) { compAnc.add(p); p = p.parentElement; }
      let best = null, bestDist = 1e9;
      for (const h of h2s) {
        let dist=0, cur=h;
        while (cur && !compAnc.has(cur)) { cur=cur.parentElement; dist++; }
        if (cur && dist < bestDist) { bestDist = dist; best = h; }
      }
      if (best) return (best.innerText || "").trim();
    }
    return "unknown";
  }

  function getThreadKey() {
    const path = location.pathname || "";
    const m = path.match(/\/(?:e2ee\/)?t\/([^/?#]+)/);
    if (m && m[1]) return `tid:${decodeURIComponent(m[1])}`;
    const aria = getMessageGrid()?.getAttribute("aria-label") || "";
    if (aria) return `aria:${hash(aria)}`;
    return `href:${hash(location.href)}`;
  }

  function getGridRows() {
    const grid = getMessageGrid();
    if (!grid) return [];
    return qsa('[role="row"]', grid); // scoped to grid only
  }

  function looksLikeTypingIndicator(row) {
    const txt = (row.textContent || "").toLowerCase();
    if (/typing|is typing…|recording audio|gif picker|sticker/.test(txt)) return true;
    if (row.querySelector('[role="progressbar"], [aria-busy="true"]')) return true;
    return false;
  }

  function makeRowKey(row) {
    const html = (row.outerHTML || "").slice(0, MAX_ROW_HTML_FINGERPRINT);
    return `r${hash(html)}:${html.length}`;
  }

  function extractText(row) {
    // 1) visible blocks
    const blocks = qsa('div[dir="auto"]:not([aria-hidden="true"])', row);
    const parts = [];
    for (const el of blocks) {
      if (el.querySelector("time, [data-testid*='timestamp']")) continue;
      const t = (el.innerText || "").trim();
      if (t) parts.push(t);
    }
    if (parts.length) return parts.join("\n");

    // 2) spans
    const spans = qsa("span", row).map(s => (s.innerText || "").trim()).filter(Boolean);
    if (spans.length) return spans.join("\n");

    // 3) last resort
    return (row.textContent || "").trim();
  }

  // ---------- author detection (group-aware) ----------
  function extractAuthorFromRow(row, convoTitle) {
    // Group chats: author appears in <h5> for each bubble
    const h5 = row.querySelector("h5");
    if (h5) {
      let name = (h5.innerText || "").trim();
      if (name) {
        // Normalize “You sent …” cases
        if (/^you sent/i.test(name)) return "me";
        // Clean common edit markers that leak into h5 (e.g., "Teresa  ·  Edited")
        name = name.replace(/·\s*edited/i, "").replace(/\s{2,}/g, " ").trim();
        // Sometimes h5 can hold "Teresa  🙂  Edited" → strip trailing "Edited" word
        name = name.replace(/\s+edited$/i, "").trim();
        return name || convoTitle || "unknown";
      }
    }

    // Non-group (1:1) or no h5:
    // Try “You sent” inside the row
    const explicitYou = qsa("span,div", row).some(el => /^(you sent|you reacted|you replied)/i.test(el.textContent || ""));
    if (explicitYou) return "me";

    // Otherwise, assume the other participant (use conversation title)
    return convoTitle || "unknown";
  }

  // -------- Per-thread last message memory --------
  const lastRowKeyPerThread = new Map();
  const alreadySent = (threadKey, rowKey) => lastRowKeyPerThread.get(threadKey) === rowKey;
  const markSent = (threadKey, rowKey) => lastRowKeyPerThread.set(threadKey, rowKey);

  // ---------------- Forwarding ----------------
  function sendToDiscord(payload) {
    if (!wsConnected || !ws || ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify(payload)); } catch (e) { console.warn("[TM][WS] send error", e); }
  }

  function forwardRowIfNew(row) {
    if (!row || looksLikeTypingIndicator(row)) return;

    const threadKey = getThreadKey();
    const rowKey = makeRowKey(row);
    if (alreadySent(threadKey, rowKey)) return;

    const text = extractText(row).trim();
    if (!text) { markSent(threadKey, rowKey); return; }

    const title = getConversationTitleSafe();                 // e.g., "Conying Putot"
    const author = extractAuthorFromRow(row, title);          // e.g., "Teresa" | "John" | "me"
    const content = `${author}: ${text}`;

    sendToDiscord({
      direction: "messenger_to_discord",
      channel_hint: title,   // bot will create/use #conying-putot
      sender: title,         // kept for backward compatibility
      type: "text",
      content
    });

    markSent(threadKey, rowKey);
    console.log("[TM] →", `#${title}`, content.slice(0, 140));
  }

  function forwardLastVisibleRowInGrid() {
    const rows = getGridRows();
    if (!rows.length) return;
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      if (looksLikeTypingIndicator(r)) continue;
      const t = extractText(r).trim();
      if (!t) continue;
      forwardRowIfNew(r);
      return;
    }
  }

  // ------------- Thread change detection -------------
  let currentThreadKey = getThreadKey();
  let urlAtLastCheck = location.href;
  let titleAtLastCheck = getConversationTitleSafe();

  (function patchHistory() {
    const P = history.pushState.bind(history);
    const R = history.replaceState.bind(history);
    history.pushState = function () { const r = P(...arguments); onPossibleThreadChange("pushState"); return r; };
    history.replaceState = function () { const r = R(...arguments); onPossibleThreadChange("replaceState"); return r; };
    window.addEventListener("popstate", () => onPossibleThreadChange("popstate"));
  })();

  setInterval(() => onPossibleThreadChange("poll"), 500);

  let threadChangeCooldown = false;
  function onPossibleThreadChange(source) {
    const href = location.href;
    const title = getConversationTitleSafe();
    const maybeChanged = (href !== urlAtLastCheck) || (title !== titleAtLastCheck);
    if (!maybeChanged) return;

    urlAtLastCheck = href;
    titleAtLastCheck = title;

    const newKey = getThreadKey();
    if (newKey === currentThreadKey) return;

    currentThreadKey = newKey;
    console.log(`[TM] thread change (${source}) →`, title || newKey);

    if (threadChangeCooldown) return;
    threadChangeCooldown = true;
    setTimeout(() => { threadChangeCooldown = false; forwardLastVisibleRowInGrid(); }, INITIAL_SEND_DELAY_MS);
  }

  // ------------- Observe message grid -------------
  let debounceTimer = null;
  const ro = new MutationObserver(() => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => forwardLastVisibleRowInGrid(), MUTATION_DEBOUNCE_MS);
  });

  function start() {
    ro.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => forwardLastVisibleRowInGrid(), INITIAL_SEND_DELAY_MS);
  }

  const bootIv = setInterval(() => {
    if (getComposer() && getMessageGrid()) { clearInterval(bootIv); start(); }
  }, 400);
})();
