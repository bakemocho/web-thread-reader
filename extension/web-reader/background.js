"use strict";

const OFFSCREEN_URL = "offscreen.html";
let creatingOffscreenPromise = null;

function isOffscreenContext(context) {
  return context && context.contextType === "OFFSCREEN_DOCUMENT";
}

async function hasOffscreenDocument() {
  if (!chrome.runtime.getContexts) {
    return false;
  }

  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });

  return contexts.some(isOffscreenContext);
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    return;
  }

  if (creatingOffscreenPromise) {
    return creatingOffscreenPromise;
  }

  creatingOffscreenPromise = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      reasons: ["AUDIO_PLAYBACK"],
      justification: "Play speech synthesis across page navigations.",
    })
    .catch(async (error) => {
      // If another call created it first, treat as success.
      if (
        error &&
        typeof error.message === "string" &&
        error.message.includes("Only a single offscreen document may be created")
      ) {
        return;
      }
      if (await hasOffscreenDocument()) {
        return;
      }
      throw error;
    })
    .finally(() => {
      creatingOffscreenPromise = null;
    });

  return creatingOffscreenPromise;
}

async function sendToOffscreen(message) {
  await ensureOffscreenDocument();
  return chrome.runtime.sendMessage(message);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.type) {
    return false;
  }
  if (
    message.type !== "WEB_READER_BG_SPEAK" &&
    message.type !== "WEB_READER_BG_STOP" &&
    message.type !== "WEB_READER_BG_PAUSE" &&
    message.type !== "WEB_READER_BG_RESUME" &&
    message.type !== "WEB_READER_BG_STATUS"
  ) {
    return false;
  }

  (async () => {
    try {
      if (message.type === "WEB_READER_BG_SPEAK") {
        const response = await sendToOffscreen({
          type: "WEB_READER_OFFSCREEN_SPEAK",
          text: message.text,
          settings: message.settings || null,
        });
        sendResponse(response && typeof response === "object" ? response : { ok: false, error: "No response." });
        return;
      }

      if (message.type === "WEB_READER_BG_STOP") {
        let response = { ok: true };
        if (await hasOffscreenDocument()) {
          const result = await chrome.runtime.sendMessage({ type: "WEB_READER_OFFSCREEN_STOP" });
          if (result && typeof result === "object") {
            response = result;
          }
        }
        sendResponse(response);
        return;
      }

      if (message.type === "WEB_READER_BG_PAUSE") {
        if (!(await hasOffscreenDocument())) {
          sendResponse({ ok: false, error: "No active browser playback." });
          return;
        }
        const result = await chrome.runtime.sendMessage({ type: "WEB_READER_OFFSCREEN_PAUSE" });
        sendResponse(result && typeof result === "object" ? result : { ok: false, error: "No response." });
        return;
      }

      if (message.type === "WEB_READER_BG_RESUME") {
        if (!(await hasOffscreenDocument())) {
          sendResponse({ ok: false, error: "No paused browser playback." });
          return;
        }
        const result = await chrome.runtime.sendMessage({ type: "WEB_READER_OFFSCREEN_RESUME" });
        sendResponse(result && typeof result === "object" ? result : { ok: false, error: "No response." });
        return;
      }

      if (message.type === "WEB_READER_BG_STATUS") {
        if (!(await hasOffscreenDocument())) {
          sendResponse({ ok: true, state: "idle", chars: 0, chunks: 0, lang: null });
          return;
        }
        const result = await chrome.runtime.sendMessage({ type: "WEB_READER_OFFSCREEN_STATUS" });
        sendResponse(
          result && typeof result === "object"
            ? result
            : { ok: true, state: "idle", chars: 0, chunks: 0, lang: null }
        );
        return;
      }
    } catch (error) {
      sendResponse({ ok: false, error: error && error.message ? error.message : String(error) });
    }
  })();

  return true;
});
