let ws;

function connectWS() {
  ws = new WebSocket("ws://localhost:8080");

  ws.onopen = () => {
    console.log("[WS] connected to bot");
    ws.send(JSON.stringify({ kind: "ping" }));
  };

  ws.onclose = () => {
    console.log("[WS] disconnected; retrying…");
    setTimeout(connectWS, 2000);
  };

  ws.onerror = (e) => console.warn("[WS] error", e);

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);

    // Discord -> Messenger
    if (data.direction === "discord_to_messenger") {
      chrome.tabs.query({ url: "*://www.messenger.com/*" }, (tabs) => {
        if (!tabs?.length) return;
        chrome.scripting.executeScript({
          target: { tabId: tabs[0].id },
          func: receiveFromDiscordInPage,
          args: [data]
        });
      });
    }
  };
}

// Runs in Messenger page context
function receiveFromDiscordInPage(payload) {
  function findComposer() {
    // Heuristic: the main chat composer input
    return document.querySelector('[contenteditable="true"][role="textbox"]');
  }

  async function sendText(content) {
    const composer = findComposer();
    if (!composer) return;

    composer.focus();
    document.execCommand("insertText", false, content || "");
    composer.dispatchEvent(new InputEvent("input", { bubbles: true }));

    composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
  }

  async function sendFiles(files, caption) {
    const composer = findComposer();
    if (!composer) return;

    if (caption) {
      composer.focus();
      document.execCommand("insertText", false, caption);
      composer.dispatchEvent(new InputEvent("input", { bubbles: true }));
    }

    const dt = new DataTransfer();
    for (const f of files) {
      const bin = atob(f.base64);
      const len = bin.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: f.mime || "application/octet-stream" });
      const file = new File([blob], f.name || "file", { type: f.mime || blob.type });
      dt.items.add(file);
    }

    const rect = composer.getBoundingClientRect();
    const dropEvent = new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
      dataTransfer: dt,
      clientX: rect.left + 10,
      clientY: rect.top + 10
    });
    composer.dispatchEvent(dropEvent);

    setTimeout(() => {
      composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
    }, 400);
  }

  if (payload.type === "text") {
    sendText(payload.content || "");
  } else if (payload.type === "file") {
    sendFiles(payload.files || [], payload.content || "");
  }
}

// Relay content-script messages over WS
chrome.runtime.onMessage.addListener((msg) => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(msg));
});

connectWS();
