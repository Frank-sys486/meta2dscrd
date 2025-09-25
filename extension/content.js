// Watches Messenger DOM for new messages and forwards text/files to background -> WS -> bot.

const PRIMARY_CONTAINER_SELECTOR = ["[data-message-id]", "[data-testid^='mw_message_row']", "[role='row']"].join(",");
const MESSAGE_SELECTOR = [
  PRIMARY_CONTAINER_SELECTOR,
  "div[dir='auto'][class*='x1yc453h'][class*='x126k92a']"
].join(",");

const SEEN_NODES = new WeakSet();
const SEEN_KEYS = new Set();

const observer = new MutationObserver((mutations) => {
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      if (node.nodeType !== 1) continue;

      // Heuristic: each message row
      const bubbles = collectCandidateNodes(node);
      if (!bubbles || bubbles.length === 0) continue;

      bubbles.forEach(parseBubbleIfNew);
    }
  }
});

observer.observe(document.body, { childList: true, subtree: true });

// also sweep recent rows once after load
setTimeout(() => {
  document.querySelectorAll(MESSAGE_SELECTOR).forEach(parseBubbleIfNew);
}, 1500);

setInterval(() => {
  document.querySelectorAll(MESSAGE_SELECTOR).forEach(parseBubbleIfNew);
}, 5000);

function collectCandidateNodes(node) {
  if (node.nodeType !== 1) return [];

  const candidates = [];
  if (node.matches?.(MESSAGE_SELECTOR)) {
    candidates.push(node);
  }
  node.querySelectorAll?.(MESSAGE_SELECTOR)?.forEach((el) => {
    if (!candidates.includes(el)) candidates.push(el);
  });
  return candidates;
}

function parseBubbleIfNew(bubble) {
  if (!bubble) return;

  const contextNode = bubble.matches?.(PRIMARY_CONTAINER_SELECTOR)
    ? bubble
    : bubble.closest?.(PRIMARY_CONTAINER_SELECTOR) || bubble;

  if (SEEN_NODES.has(contextNode) || SEEN_NODES.has(bubble)) return;

  const syntheticId = buildSyntheticId(contextNode);
  if (syntheticId && SEEN_KEYS.has(syntheticId)) return;

  SEEN_NODES.add(bubble);
  SEEN_NODES.add(contextNode);
  if (syntheticId) SEEN_KEYS.add(syntheticId);

  const { sender } = resolveSender();
  const textContent = extractTextFromBubble(contextNode);
  const filePromises = extractFilesFromBubble(contextNode);

  Promise.all(filePromises)
    .then((files) => {
      const cleanFiles = (files || []).filter(Boolean);
      if (cleanFiles.length > 0) {
        chrome.runtime.sendMessage({
          direction: "messenger_to_discord",
          sender,
          type: "file",
          content: textContent || "",
          files: cleanFiles
        });
      } else if (textContent) {
        chrome.runtime.sendMessage({
          direction: "messenger_to_discord",
          sender,
          type: "text",
          content: textContent
        });
      } else {
        const fallbackText = fallbackBubbleText(bubble);
        if (fallbackText) {
          chrome.runtime.sendMessage({
            direction: "messenger_to_discord",
            sender,
            type: "text",
            content: fallbackText
          });
        }
      }
    })
    .catch(console.warn);
}

function buildSyntheticId(bubble) {
  const dataId = bubble.getAttribute("data-message-id");
  if (dataId) return dataId;

  const time =
    bubble.querySelector("time")?.getAttribute("datetime") ||
    bubble.getAttribute("data-tooltip-content") ||
    bubble.getAttribute("aria-label") ||
    "";

  const attachmentsKey = Array.from(bubble.querySelectorAll("img"))
    .map((img) => img.currentSrc || img.src || "")
    .filter(Boolean)
    .join("|");

  const text = extractTextFromBubble(bubble);
  if (!text && !attachmentsKey) return "";

  return `${time}::${text}::${attachmentsKey}`.slice(0, 500);
}

function resolveSender() {
  // The chat header usually holds the conversation name
  const header = document.querySelector("h1, h2");
  const sender = (header?.innerText || "unknown").trim();
  return { sender };
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
  const raw = bubble.innerText || "";
  return raw.trim();
}

function extractFilesFromBubble(bubble) {
  const promises = [];

  // Images seen in the bubble
  bubble.querySelectorAll("img").forEach((img) => {
    const src = img.currentSrc || img.src;
    if (!src) return;
    promises.push(
      fetchToBase64(src)
        .then(({ base64, mime }) => ({
          name: inferNameFromUrl(src, "image"),
          mime: mime || "image/jpeg",
          base64
        }))
        .catch(() => null)
    );
  });

  // Attachment links
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

async function fetchToBase64(url) {
  // May fail due to CORS. If so, try canvas fallback for images in DOM.
  try {
    const res = await fetch(url);
    const buf = await res.arrayBuffer();
    const mime = res.headers.get("content-type") || "";
    return { base64: arrayBufferToBase64(buf), mime };
  } catch (e) {
    // Canvas fallback for visible <img> (may still be tainted)
    const img = findImgByUrl(url);
    if (img) {
      try {
        const { base64 } = await imageToCanvasBase64(img);
        return { base64, mime: "image/png" };
      } catch {}
    }
    throw e;
  }
}

function arrayBufferToBase64(buf) {
  let binary = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function findImgByUrl(url) {
  const imgs = Array.from(document.querySelectorAll("img"));
  return imgs.find((img) => (img.currentSrc || img.src) === url);
}

function inferNameFromUrl(u, prefix) {
  try {
    const url = new URL(u);
    const file = (url.pathname.split("/").pop() || "").split("?")[0];
    if (file) return file;
  } catch {}
  return `${prefix}-${Date.now()}`;
}

function imageToCanvasBase64(img) {
  return new Promise((resolve, reject) => {
    try {
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const base64 = c.toDataURL("image/png").split(",")[1];
      resolve({ base64 });
    } catch (e) {
      reject(e);
    }
  });
}
