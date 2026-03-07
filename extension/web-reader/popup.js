"use strict";

const SETTINGS_KEY = "webReaderSettings";
const DEFAULT_SETTINGS = {
  engine: "browser",
  voicepeakEndpoint: "http://127.0.0.1:18766",
  voicepeakToken: "",
  rate: 1,
  pitch: 1,
  volume: 1,
  maxChars: 8000,
  chunkChars: 180,
};
const PLAYER_STATE = {
  IDLE: "idle",
  PLAYING: "playing",
  PAUSED: "paused",
};
const PLAYER_STATUS_POLL_MS = 1200;
const LOCAL_BROWSER_IDLE_STATE = {
  state: PLAYER_STATE.IDLE,
  chars: 0,
  chunks: 0,
  lang: null,
};

const statusEl = document.getElementById("status");
const playPauseBtn = document.getElementById("play-pause");
const resetBtn = document.getElementById("reset");

const engineSelect = document.getElementById("engine");
const voicepeakEndpointInput = document.getElementById("voicepeak-endpoint");
const voicepeakTokenInput = document.getElementById("voicepeak-token");

const rateInput = document.getElementById("rate");
const pitchInput = document.getElementById("pitch");
const volumeInput = document.getElementById("volume");
const maxCharsInput = document.getElementById("max-chars");
const chunkCharsInput = document.getElementById("chunk-chars");

let playerState = PLAYER_STATE.IDLE;
let isBusy = false;
let localBrowserSessionId = 0;
let localBrowserState = { ...LOCAL_BROWSER_IDLE_STATE };
let fallbackBrowserTabId = null;
let lastVoicepeakFailureJobId = null;
let lastVoicepeakQueuedJobId = null;
let voicepeakStatusInitialized = false;

function setStatus(text, kind = "") {
  statusEl.textContent = text;
  statusEl.className = kind ? `status ${kind}` : "status";
}

function parseNumber(input, fallback) {
  const value = Number(input.value);
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return value;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeEndpoint(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return DEFAULT_SETTINGS.voicepeakEndpoint;
  }
  return raw.replace(/\/+$/, "");
}

function setPlayPauseButtonByState() {
  const isPauseMode = playerState === PLAYER_STATE.PLAYING;
  playPauseBtn.textContent = isPauseMode ? "Pause" : "Play";
  playPauseBtn.classList.toggle("pause", isPauseMode);
}

function setBusyState(busy) {
  isBusy = busy;
  playPauseBtn.disabled = busy;
  resetBtn.disabled = busy;
}

function normalizeSpaces(text) {
  return String(text || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isJapaneseText(text) {
  const value = String(text || "");
  let jpCount = 0;
  let letterCount = 0;
  for (const ch of value) {
    if (/\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Han}/u.test(ch)) {
      jpCount += 1;
      letterCount += 1;
    } else if (/\p{L}/u.test(ch)) {
      letterCount += 1;
    }
  }
  if (letterCount === 0) {
    return true;
  }
  return jpCount / letterCount >= 0.3;
}

function splitIntoSpeechChunks(text, chunkChars) {
  const maxLen = clamp(Number(chunkChars) || DEFAULT_SETTINGS.chunkChars, 60, 500);
  const input = normalizeSpaces(text);
  if (!input) {
    return [];
  }

  const sentences = input
    .replace(/\r\n/g, "\n")
    .split(/(?<=[。．！？!?\n])/)
    .map((part) => normalizeSpaces(part))
    .filter(Boolean);

  const chunks = [];
  let current = "";

  const pushCurrent = () => {
    const value = normalizeSpaces(current);
    if (value) {
      chunks.push(value);
    }
    current = "";
  };

  for (const sentence of sentences) {
    if (sentence.length > maxLen) {
      pushCurrent();
      for (let index = 0; index < sentence.length; index += maxLen) {
        chunks.push(sentence.slice(index, index + maxLen));
      }
      continue;
    }

    if (!current) {
      current = sentence;
    } else if ((current + sentence).length <= maxLen) {
      current += sentence;
    } else {
      pushCurrent();
      current = sentence;
    }
  }

  pushCurrent();
  return chunks;
}

function pickVoice(lang) {
  const synth = window.speechSynthesis;
  if (!synth || typeof synth.getVoices !== "function") {
    return null;
  }
  const voices = synth.getVoices();
  if (!Array.isArray(voices) || voices.length === 0) {
    return null;
  }

  const exact = voices.find((voice) => String(voice.lang || "").toLowerCase() === lang.toLowerCase());
  if (exact) {
    return exact;
  }

  const prefix = voices.find((voice) =>
    String(voice.lang || "").toLowerCase().startsWith(lang.slice(0, 2).toLowerCase())
  );
  if (prefix) {
    return prefix;
  }

  return voices[0] || null;
}

function snapshotLocalBrowserState() {
  return { ...localBrowserState };
}

function markLocalBrowserIdle() {
  localBrowserState = { ...LOCAL_BROWSER_IDLE_STATE };
}

function setLocalBrowserState(partial) {
  localBrowserState = {
    ...localBrowserState,
    ...(partial || {}),
  };
}

function stopLocalBrowserSpeech() {
  localBrowserSessionId += 1;
  if (window.speechSynthesis && typeof window.speechSynthesis.cancel === "function") {
    window.speechSynthesis.cancel();
  }
  markLocalBrowserIdle();
  return {
    ok: true,
    ...snapshotLocalBrowserState(),
    transport: "popup_local",
  };
}

function pauseLocalBrowserSpeech() {
  const synth = window.speechSynthesis;
  if (!synth || typeof synth.pause !== "function") {
    return { ok: false, error: "Browser speech API unavailable." };
  }
  if (localBrowserState.state !== PLAYER_STATE.PLAYING) {
    return { ok: false, error: "Browser TTS is not playing." };
  }
  if (!synth.speaking && !synth.pending) {
    return { ok: false, error: "No active browser playback." };
  }

  synth.pause();
  setLocalBrowserState({ state: PLAYER_STATE.PAUSED });
  return {
    ok: true,
    ...snapshotLocalBrowserState(),
    transport: "popup_local",
  };
}

function resumeLocalBrowserSpeech() {
  const synth = window.speechSynthesis;
  if (!synth || typeof synth.resume !== "function") {
    return { ok: false, error: "Browser speech API unavailable." };
  }
  if (localBrowserState.state !== PLAYER_STATE.PAUSED) {
    return { ok: false, error: "Browser TTS is not paused." };
  }

  synth.resume();
  setLocalBrowserState({ state: PLAYER_STATE.PLAYING });
  return {
    ok: true,
    ...snapshotLocalBrowserState(),
    transport: "popup_local",
  };
}

function startLocalBrowserSpeech(text, settings) {
  const synth = window.speechSynthesis;
  if (!synth || typeof window.SpeechSynthesisUtterance !== "function") {
    return { ok: false, error: "Browser speech API unavailable." };
  }

  const mergedSettings = {
    ...DEFAULT_SETTINGS,
    ...(settings || {}),
  };
  const normalized = normalizeSpaces(text).slice(0, mergedSettings.maxChars);
  if (!normalized) {
    return { ok: false, error: "No readable text found." };
  }

  const chunks = splitIntoSpeechChunks(normalized, mergedSettings.chunkChars);
  if (chunks.length === 0) {
    return { ok: false, error: "No readable text found." };
  }

  stopLocalBrowserSpeech();
  const activeSession = localBrowserSessionId;
  const lang = isJapaneseText(normalized) ? "ja-JP" : "en-US";
  const voice = pickVoice(lang);

  setLocalBrowserState({
    state: PLAYER_STATE.PLAYING,
    chars: normalized.length,
    chunks: chunks.length,
    lang,
  });

  let finishedChunks = 0;
  const finalizeChunk = () => {
    if (activeSession !== localBrowserSessionId) {
      return;
    }
    finishedChunks += 1;
    if (finishedChunks >= chunks.length) {
      markLocalBrowserIdle();
    }
  };

  // Queue all chunks up-front so the browser speech engine can progress without
  // waiting for JS onend callbacks between chunks.
  for (const chunk of chunks) {
    const utterance = new SpeechSynthesisUtterance(chunk);
    utterance.lang = lang;
    utterance.rate = clamp(Number(mergedSettings.rate) || DEFAULT_SETTINGS.rate, 0.5, 2);
    utterance.pitch = clamp(Number(mergedSettings.pitch) || DEFAULT_SETTINGS.pitch, 0, 2);
    utterance.volume = clamp(Number(mergedSettings.volume) || DEFAULT_SETTINGS.volume, 0, 1);
    if (voice) {
      utterance.voice = voice;
    }

    utterance.onend = finalizeChunk;
    utterance.onerror = finalizeChunk;
    synth.speak(utterance);
  }
  return {
    ok: true,
    ...snapshotLocalBrowserState(),
    transport: "popup_local",
  };
}

function asErrorMessage(error) {
  if (!error) {
    return "unknown_error";
  }
  if (typeof error === "string") {
    return error;
  }
  if (error.message) {
    return error.message;
  }
  return String(error);
}

function isOffscreenUnavailableError(error) {
  const message = asErrorMessage(error);
  return (
    message.includes("offscreen_unavailable") ||
    message.includes("offscreen") ||
    message.includes("AUDIO_PLAYBACK")
  );
}

async function loadSettings() {
  const stored = await chrome.storage.local.get({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
  const value = stored[SETTINGS_KEY] || DEFAULT_SETTINGS;

  engineSelect.value = value.engine === "voicepeak" ? "voicepeak" : "browser";
  voicepeakEndpointInput.value = normalizeEndpoint(value.voicepeakEndpoint);
  voicepeakTokenInput.value = String(value.voicepeakToken || "");

  rateInput.value = String(clamp(Number(value.rate) || DEFAULT_SETTINGS.rate, 0.5, 2));
  pitchInput.value = String(clamp(Number(value.pitch) || DEFAULT_SETTINGS.pitch, 0, 2));
  volumeInput.value = String(clamp(Number(value.volume) || DEFAULT_SETTINGS.volume, 0, 1));
  maxCharsInput.value = String(clamp(Number(value.maxChars) || DEFAULT_SETTINGS.maxChars, 500, 40000));
  chunkCharsInput.value = String(clamp(Number(value.chunkChars) || DEFAULT_SETTINGS.chunkChars, 60, 500));
}

async function saveSettings() {
  const value = {
    engine: engineSelect.value === "voicepeak" ? "voicepeak" : "browser",
    voicepeakEndpoint: normalizeEndpoint(voicepeakEndpointInput.value),
    voicepeakToken: String(voicepeakTokenInput.value || "").trim(),
    rate: clamp(parseNumber(rateInput, DEFAULT_SETTINGS.rate), 0.5, 2),
    pitch: clamp(parseNumber(pitchInput, DEFAULT_SETTINGS.pitch), 0, 2),
    volume: clamp(parseNumber(volumeInput, DEFAULT_SETTINGS.volume), 0, 1),
    maxChars: clamp(parseNumber(maxCharsInput, DEFAULT_SETTINGS.maxChars), 500, 40000),
    chunkChars: clamp(parseNumber(chunkCharsInput, DEFAULT_SETTINGS.chunkChars), 60, 500),
  };

  await chrome.storage.local.set({ [SETTINGS_KEY]: value });
  return value;
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (_) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content-script.js"],
    });
    return chrome.tabs.sendMessage(tabId, message);
  }
}

async function requireActiveHttpTab() {
  const tab = await getActiveTab();
  if (!tab || typeof tab.id !== "number") {
    throw new Error("Active tab not found.");
  }
  if (!tab.url || !/^https?:\/\//.test(tab.url)) {
    throw new Error("This page cannot be controlled.");
  }
  return tab;
}

function isControllableTab(tab) {
  return Boolean(tab && typeof tab.id === "number" && tab.url && /^https?:\/\//.test(tab.url));
}

async function runTabSpeechCommand(tabId, message, fallbackError) {
  if (!chrome.scripting || typeof chrome.scripting.executeScript !== "function") {
    throw new Error(fallbackError || "Script injection API unavailable.");
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (inputMessage) => {
      const PLAYER_STATE = {
        IDLE: "idle",
        PLAYING: "playing",
        PAUSED: "paused",
      };
      const PLAYER_IDLE_STATE = {
        state: PLAYER_STATE.IDLE,
        chars: 0,
        chunks: 0,
        lang: null,
      };
      const STORE_KEY = "__WEB_READER_TAB_TTS_STORE__";
      if (!window[STORE_KEY] || typeof window[STORE_KEY] !== "object") {
        window[STORE_KEY] = {
          sessionId: 0,
          state: { ...PLAYER_IDLE_STATE },
        };
      }
      const store = window[STORE_KEY];

      const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
      const normalizeSpaces = (text) =>
        String(text || "")
          .replace(/\u00a0/g, " ")
          .replace(/[ \t]+/g, " ")
          .replace(/\n{3,}/g, "\n\n")
          .trim();
      const snapshot = () => ({ ...store.state });
      const setState = (partial) => {
        store.state = {
          ...store.state,
          ...(partial || {}),
        };
      };
      const markIdle = () => {
        store.state = { ...PLAYER_IDLE_STATE };
      };
      const isJapaneseText = (text) => {
        const value = String(text || "");
        let jpCount = 0;
        let letterCount = 0;
        for (const ch of value) {
          if (/\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Han}/u.test(ch)) {
            jpCount += 1;
            letterCount += 1;
          } else if (/\p{L}/u.test(ch)) {
            letterCount += 1;
          }
        }
        if (letterCount === 0) {
          return true;
        }
        return jpCount / letterCount >= 0.3;
      };
      const splitIntoChunks = (text, chunkChars) => {
        const maxLen = clamp(Number(chunkChars) || 180, 60, 500);
        const input = normalizeSpaces(text);
        if (!input) {
          return [];
        }

        const sentences = input
          .replace(/\r\n/g, "\n")
          .split(/(?<=[。．！？!?\n])/)
          .map((part) => normalizeSpaces(part))
          .filter(Boolean);

        const chunks = [];
        let current = "";
        const pushCurrent = () => {
          const value = normalizeSpaces(current);
          if (value) {
            chunks.push(value);
          }
          current = "";
        };

        for (const sentence of sentences) {
          if (sentence.length > maxLen) {
            pushCurrent();
            for (let index = 0; index < sentence.length; index += maxLen) {
              chunks.push(sentence.slice(index, index + maxLen));
            }
            continue;
          }

          if (!current) {
            current = sentence;
          } else if ((current + sentence).length <= maxLen) {
            current += sentence;
          } else {
            pushCurrent();
            current = sentence;
          }
        }
        pushCurrent();
        return chunks;
      };
      const pickVoice = (lang) => {
        if (!window.speechSynthesis || typeof window.speechSynthesis.getVoices !== "function") {
          return null;
        }
        const voices = window.speechSynthesis.getVoices();
        if (!Array.isArray(voices) || voices.length === 0) {
          return null;
        }

        const exact = voices.find((voice) => String(voice.lang || "").toLowerCase() === lang.toLowerCase());
        if (exact) {
          return exact;
        }

        const prefix = voices.find((voice) =>
          String(voice.lang || "").toLowerCase().startsWith(lang.slice(0, 2).toLowerCase())
        );
        if (prefix) {
          return prefix;
        }

        return voices[0] || null;
      };

      const stop = () => {
        store.sessionId += 1;
        if (window.speechSynthesis && typeof window.speechSynthesis.cancel === "function") {
          window.speechSynthesis.cancel();
        }
        markIdle();
        return {
          ok: true,
          ...snapshot(),
          transport: "tab_local_exec",
        };
      };
      const pause = () => {
        const synth = window.speechSynthesis;
        if (!synth || typeof synth.pause !== "function") {
          return { ok: false, error: "Browser speech API unavailable." };
        }
        if (store.state.state !== PLAYER_STATE.PLAYING) {
          return { ok: false, error: "Browser TTS is not playing." };
        }
        if (!synth.speaking && !synth.pending) {
          return { ok: false, error: "No active browser playback." };
        }
        synth.pause();
        setState({ state: PLAYER_STATE.PAUSED });
        return {
          ok: true,
          ...snapshot(),
          transport: "tab_local_exec",
        };
      };
      const resume = () => {
        const synth = window.speechSynthesis;
        if (!synth || typeof synth.resume !== "function") {
          return { ok: false, error: "Browser speech API unavailable." };
        }
        if (store.state.state !== PLAYER_STATE.PAUSED) {
          return { ok: false, error: "Browser TTS is not paused." };
        }
        synth.resume();
        setState({ state: PLAYER_STATE.PLAYING });
        return {
          ok: true,
          ...snapshot(),
          transport: "tab_local_exec",
        };
      };
      const status = () => {
        const synth = window.speechSynthesis;
        if (
          store.state.state === PLAYER_STATE.PLAYING &&
          synth &&
          typeof synth.speaking === "boolean" &&
          typeof synth.pending === "boolean" &&
          !synth.speaking &&
          !synth.pending
        ) {
          markIdle();
        }
        return {
          ok: true,
          ...snapshot(),
          transport: "tab_local_exec",
        };
      };
      const speak = (message) => {
        const synth = window.speechSynthesis;
        if (!synth || typeof window.SpeechSynthesisUtterance !== "function") {
          return { ok: false, error: "Browser speech API unavailable." };
        }

        const rawSettings = message && message.settings && typeof message.settings === "object" ? message.settings : {};
        const normalized = normalizeSpaces(message && message.text ? message.text : "").slice(
          0,
          clamp(Number(rawSettings.maxChars) || 8000, 500, 40000)
        );
        if (!normalized) {
          return { ok: false, error: "No readable text found." };
        }

        const chunks = splitIntoChunks(normalized, rawSettings.chunkChars);
        if (chunks.length === 0) {
          return { ok: false, error: "No readable text found." };
        }

        stop();
        const activeSession = store.sessionId;
        const lang = isJapaneseText(normalized) ? "ja-JP" : "en-US";
        const voice = pickVoice(lang);
        setState({
          state: PLAYER_STATE.PLAYING,
          chars: normalized.length,
          chunks: chunks.length,
          lang,
        });

        let finishedChunks = 0;
        const finalizeChunk = () => {
          if (activeSession !== store.sessionId) {
            return;
          }
          finishedChunks += 1;
          if (finishedChunks >= chunks.length) {
            markIdle();
          }
        };

        for (const chunk of chunks) {
          if (activeSession !== store.sessionId) {
            break;
          }
          const utterance = new SpeechSynthesisUtterance(chunk);
          utterance.lang = lang;
          utterance.rate = clamp(Number(rawSettings.rate) || 1, 0.5, 2);
          utterance.pitch = clamp(Number(rawSettings.pitch) || 1, 0, 2);
          utterance.volume = clamp(Number(rawSettings.volume) || 1, 0, 1);
          if (voice) {
            utterance.voice = voice;
          }
          utterance.onend = finalizeChunk;
          utterance.onerror = finalizeChunk;
          synth.speak(utterance);
        }

        return {
          ok: true,
          ...snapshot(),
          transport: "tab_local_exec",
        };
      };

      if (!inputMessage || !inputMessage.type) {
        return { ok: false, error: "Invalid command." };
      }

      if (inputMessage.type === "WEB_READER_SPEAK_TEXT") {
        return speak(inputMessage);
      }
      if (inputMessage.type === "WEB_READER_PAUSE") {
        return pause();
      }
      if (inputMessage.type === "WEB_READER_RESUME") {
        return resume();
      }
      if (inputMessage.type === "WEB_READER_STOP") {
        return stop();
      }
      if (inputMessage.type === "WEB_READER_STATUS") {
        return status();
      }
      return { ok: false, error: "Unknown tab speech command." };
    },
    args: [message],
  });

  const payload = Array.isArray(results) && results[0] ? results[0].result : null;
  if (!payload || !payload.ok) {
    throw new Error((payload && payload.error) || fallbackError || "Tab speech failed.");
  }
  fallbackBrowserTabId = tabId;
  return {
    ...payload,
    transport: "tab_local",
    tabId,
  };
}

async function speakInTabBrowser(tabId, text, settings) {
  try {
    const response = await sendToTab(tabId, {
      type: "WEB_READER_SPEAK_TEXT",
      text,
      settings: {
        rate: settings.rate,
        pitch: settings.pitch,
        volume: settings.volume,
        maxChars: settings.maxChars,
        chunkChars: settings.chunkChars,
      },
    });
    if (!response || !response.ok) {
      throw new Error(response && response.error ? response.error : "Browser speech failed.");
    }
    fallbackBrowserTabId = tabId;
    return {
      ...response,
      transport: "tab_local",
      tabId,
    };
  } catch (_) {
    return runTabSpeechCommand(
      tabId,
      {
        type: "WEB_READER_SPEAK_TEXT",
        text,
        settings: {
          rate: settings.rate,
          pitch: settings.pitch,
          volume: settings.volume,
          maxChars: settings.maxChars,
          chunkChars: settings.chunkChars,
        },
      },
      "Browser speech failed."
    );
  }
}

async function sendToFallbackBrowserTab(message, fallbackError) {
  const candidateTabIds = [];
  if (typeof fallbackBrowserTabId === "number") {
    candidateTabIds.push(fallbackBrowserTabId);
  }

  const activeTab = await getActiveTab();
  if (isControllableTab(activeTab) && !candidateTabIds.includes(activeTab.id)) {
    candidateTabIds.push(activeTab.id);
  }

  let lastError = null;
  for (const tabId of candidateTabIds) {
    try {
      const response = await sendToTab(tabId, message);
      if (response && response.ok) {
        fallbackBrowserTabId = tabId;
        return {
          ...response,
          transport: "tab_local",
          tabId,
        };
      }
      const fallbackResponse = await runTabSpeechCommand(tabId, message, fallbackError);
      return fallbackResponse;
    } catch (error) {
      try {
        const fallbackResponse = await runTabSpeechCommand(tabId, message, fallbackError);
        return fallbackResponse;
      } catch (innerError) {
        lastError = innerError;
      }
      if (fallbackBrowserTabId === tabId) {
        fallbackBrowserTabId = null;
      }
    }
  }

  throw lastError || new Error(fallbackError || "No controllable tab.");
}

async function extractText(tabId, mode) {
  const type = mode === "x" ? "WEB_READER_EXTRACT_X" : "WEB_READER_EXTRACT_PAGE";
  const response = await sendToTab(tabId, { type });
  if (!response || !response.ok) {
    throw new Error(response && response.error ? response.error : "Failed to extract text.");
  }
  return response;
}

async function fallbackExtractPageText(tabId) {
  if (!chrome.scripting || typeof chrome.scripting.executeScript !== "function") {
    throw new Error("Script injection API unavailable.");
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      function normalizeSpaces(text) {
        return String(text || "")
          .replace(/\u00a0/g, " ")
          .replace(/[ \t]+/g, " ")
          .replace(/\n{3,}/g, "\n\n")
          .trim();
      }

      function isVisibleElement(element) {
        if (!element || !element.isConnected) {
          return false;
        }
        const style = window.getComputedStyle(element);
        if (!style || style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
          return false;
        }
        return true;
      }

      function buildPageText(root) {
        const parts = [];
        const seen = new Set();
        const nodes = root.querySelectorAll("h1,h2,h3,p,li,blockquote,pre");
        for (const node of nodes) {
          if (!isVisibleElement(node)) {
            continue;
          }
          const text = normalizeSpaces(node.innerText);
          if (text.length < 2 || seen.has(text)) {
            continue;
          }
          seen.add(text);
          parts.push(text);
        }

        if (parts.length > 0) {
          return parts.join("\n");
        }
        return normalizeSpaces(root.innerText);
      }

      function pickMainRoot() {
        const articleCandidates = Array.from(document.querySelectorAll("article"));
        let bestArticle = null;
        let bestArticleLen = 0;
        for (const node of articleCandidates) {
          if (!isVisibleElement(node)) {
            continue;
          }
          const len = normalizeSpaces(node.innerText).length;
          if (len > bestArticleLen) {
            bestArticle = node;
            bestArticleLen = len;
          }
        }

        if (bestArticle && bestArticleLen >= 300) {
          return bestArticle;
        }

        const main = document.querySelector("main") || document.querySelector('[role="main"]');
        if (main && isVisibleElement(main)) {
          return main;
        }
        return document.body;
      }

      const root = pickMainRoot();
      const text = normalizeSpaces(buildPageText(root));
      if (!text) {
        return { ok: false, error: "No readable text found." };
      }
      return { ok: true, text, chars: text.length };
    },
  });

  const payload = Array.isArray(results) && results[0] ? results[0].result : null;
  if (payload && payload.ok) {
    return payload;
  }
  throw new Error((payload && payload.error) || "Failed to extract text.");
}

async function extractTextAuto(tabId) {
  let xResponse = null;
  let pageResponse = null;
  let fallbackError = null;

  try {
    xResponse = await sendToTab(tabId, { type: "WEB_READER_EXTRACT_X" });
  } catch (error) {
    xResponse = { ok: false, error: asErrorMessage(error) };
  }
  if (xResponse && xResponse.ok) {
    return {
      ...xResponse,
      mode: "x",
    };
  }

  try {
    pageResponse = await sendToTab(tabId, { type: "WEB_READER_EXTRACT_PAGE" });
  } catch (error) {
    pageResponse = { ok: false, error: asErrorMessage(error) };
  }
  if (pageResponse && pageResponse.ok) {
    return {
      ...pageResponse,
      mode: "page",
    };
  }

  try {
    const fallback = await fallbackExtractPageText(tabId);
    if (fallback && fallback.ok) {
      return {
        ...fallback,
        mode: "page",
      };
    }
  } catch (error) {
    fallbackError = error;
  }

  const error =
    (xResponse && String(xResponse.error || "").trim()) ||
    (pageResponse && String(pageResponse.error || "").trim()) ||
    (fallbackError && asErrorMessage(fallbackError)) ||
    "Failed to extract text.";
  throw new Error(error);
}

async function sendToBackground(message, fallbackError) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response || !response.ok) {
    throw new Error(response && response.error ? response.error : fallbackError);
  }
  return response;
}

function normalizePlayerState(value) {
  const state = String(value || "").toLowerCase();
  if (state === PLAYER_STATE.PLAYING) {
    return PLAYER_STATE.PLAYING;
  }
  if (state === PLAYER_STATE.PAUSED) {
    return PLAYER_STATE.PAUSED;
  }
  return PLAYER_STATE.IDLE;
}

function inferVoicepeakState(payload) {
  const fromPayload = normalizePlayerState(payload && (payload.player_state || payload.state));
  if (fromPayload !== PLAYER_STATE.IDLE) {
    return fromPayload;
  }

  if (payload && payload.active_job) {
    return PLAYER_STATE.PLAYING;
  }

  const queueLength = Number(payload && payload.queue_length);
  if (Number.isFinite(queueLength) && queueLength > 0) {
    return PLAYER_STATE.PLAYING;
  }

  return PLAYER_STATE.IDLE;
}

function normalizeJobId(value) {
  const id = Number(value);
  if (!Number.isFinite(id)) {
    return null;
  }
  return Math.trunc(id);
}

function latestFailedVoicepeakJob(payload) {
  const jobs = Array.isArray(payload && payload.recent_jobs) ? payload.recent_jobs : [];
  for (let index = jobs.length - 1; index >= 0; index -= 1) {
    const job = jobs[index];
    if (!job || String(job.status || "").toLowerCase() !== "failed") {
      continue;
    }
    if (!job.error) {
      continue;
    }
    return job;
  }
  return null;
}

function maybeShowVoicepeakFailure(payload) {
  const failedJob = latestFailedVoicepeakJob(payload);
  if (!failedJob) {
    return false;
  }

  const failedId = normalizeJobId(failedJob.id);
  if (!voicepeakStatusInitialized) {
    voicepeakStatusInitialized = true;
    if (lastVoicepeakQueuedJobId == null) {
      lastVoicepeakFailureJobId = failedId;
      return false;
    }
  }

  if (failedId != null && lastVoicepeakFailureJobId != null && failedId <= lastVoicepeakFailureJobId) {
    return false;
  }
  if (lastVoicepeakQueuedJobId != null && failedId != null && failedId < lastVoicepeakQueuedJobId) {
    return false;
  }

  lastVoicepeakFailureJobId = failedId;
  if (lastVoicepeakQueuedJobId != null && failedId != null && failedId >= lastVoicepeakQueuedJobId) {
    lastVoicepeakQueuedJobId = null;
  }

  const message = String(failedJob.error || "unknown_error");
  if (failedId != null) {
    setStatus(`Voicepeak failed (job: ${failedId}): ${message}`, "error");
  } else {
    setStatus(`Voicepeak failed: ${message}`, "error");
  }
  return true;
}

async function speakInBrowser(tabId, text, settings) {
  try {
    const response = await sendToBackground(
      {
        type: "WEB_READER_BG_SPEAK",
        text,
        settings: {
          rate: settings.rate,
          pitch: settings.pitch,
          volume: settings.volume,
          maxChars: settings.maxChars,
          chunkChars: settings.chunkChars,
        },
      },
      "Browser speech failed."
    );

    playerState = normalizePlayerState(response.state || PLAYER_STATE.PLAYING);
    return response;
  } catch (error) {
    if (!isOffscreenUnavailableError(error)) {
      throw error;
    }
    try {
      const tabResponse = await speakInTabBrowser(tabId, text, settings);
      playerState = normalizePlayerState(tabResponse.state || PLAYER_STATE.PLAYING);
      return tabResponse;
    } catch (_tabError) {
      // fall back to popup-local playback only when tab-local path is unavailable
    }
    const localResponse = startLocalBrowserSpeech(text, settings);
    if (!localResponse || !localResponse.ok) {
      throw new Error((localResponse && localResponse.error) || "Browser speech failed.");
    }
    playerState = normalizePlayerState(localResponse.state || PLAYER_STATE.PLAYING);
    return localResponse;
  }
}

async function pauseBrowserPlayback() {
  try {
    const response = await sendToBackground(
      { type: "WEB_READER_BG_PAUSE" },
      "Browser pause failed."
    );
    playerState = normalizePlayerState(response.state || PLAYER_STATE.PAUSED);
    return response;
  } catch (error) {
    if (!isOffscreenUnavailableError(error)) {
      throw error;
    }
    try {
      const tabResponse = await sendToFallbackBrowserTab(
        { type: "WEB_READER_PAUSE" },
        "Browser pause failed."
      );
      playerState = normalizePlayerState(tabResponse.state || PLAYER_STATE.PAUSED);
      return tabResponse;
    } catch (_tabError) {
      // fall back to popup-local playback only when tab-local path is unavailable
    }
    const localResponse = pauseLocalBrowserSpeech();
    if (!localResponse.ok) {
      throw new Error(localResponse.error || "Browser pause failed.");
    }
    playerState = normalizePlayerState(localResponse.state || PLAYER_STATE.PAUSED);
    return localResponse;
  }
}

async function resumeBrowserPlayback() {
  try {
    const response = await sendToBackground(
      { type: "WEB_READER_BG_RESUME" },
      "Browser resume failed."
    );
    playerState = normalizePlayerState(response.state || PLAYER_STATE.PLAYING);
    return response;
  } catch (error) {
    if (!isOffscreenUnavailableError(error)) {
      throw error;
    }
    try {
      const tabResponse = await sendToFallbackBrowserTab(
        { type: "WEB_READER_RESUME" },
        "Browser resume failed."
      );
      playerState = normalizePlayerState(tabResponse.state || PLAYER_STATE.PLAYING);
      return tabResponse;
    } catch (_tabError) {
      // fall back to popup-local playback only when tab-local path is unavailable
    }
    const localResponse = resumeLocalBrowserSpeech();
    if (!localResponse.ok) {
      throw new Error(localResponse.error || "Browser resume failed.");
    }
    playerState = normalizePlayerState(localResponse.state || PLAYER_STATE.PLAYING);
    return localResponse;
  }
}

async function stopBrowserPlayback() {
  try {
    const response = await sendToBackground(
      { type: "WEB_READER_BG_STOP" },
      "Browser stop failed."
    );
    playerState = normalizePlayerState(response.state || PLAYER_STATE.IDLE);
    return response;
  } catch (error) {
    if (!isOffscreenUnavailableError(error)) {
      throw error;
    }
    try {
      const tabResponse = await sendToFallbackBrowserTab(
        { type: "WEB_READER_STOP" },
        "Browser stop failed."
      );
      playerState = normalizePlayerState(tabResponse.state || PLAYER_STATE.IDLE);
      return tabResponse;
    } catch (_tabError) {
      // fall back to popup-local playback only when tab-local path is unavailable
    }
    const localResponse = stopLocalBrowserSpeech();
    playerState = normalizePlayerState(localResponse.state || PLAYER_STATE.IDLE);
    return localResponse;
  }
}

async function refreshBrowserPlayerState() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "WEB_READER_BG_STATUS" });
    if (response && response.ok && typeof response.state === "string") {
      playerState = normalizePlayerState(response.state);
    } else if (response && response.ok === false && isOffscreenUnavailableError(response.error)) {
      try {
        const tabStatus = await sendToFallbackBrowserTab(
          { type: "WEB_READER_STATUS" },
          "Browser status failed."
        );
        playerState = normalizePlayerState(tabStatus.state);
      } catch (_) {
        playerState = normalizePlayerState(localBrowserState.state);
      }
    } else {
      playerState = PLAYER_STATE.IDLE;
    }
  } catch (error) {
    if (isOffscreenUnavailableError(error)) {
      try {
        const tabStatus = await sendToFallbackBrowserTab(
          { type: "WEB_READER_STATUS" },
          "Browser status failed."
        );
        playerState = normalizePlayerState(tabStatus.state);
      } catch (_) {
        playerState = normalizePlayerState(localBrowserState.state);
      }
    } else {
      playerState = PLAYER_STATE.IDLE;
    }
  }

  setPlayPauseButtonByState();
}

function getVoicepeakConnection(settings) {
  const endpoint = normalizeEndpoint(
    settings && settings.voicepeakEndpoint != null
      ? settings.voicepeakEndpoint
      : voicepeakEndpointInput.value
  );
  const token = String(
    settings && settings.voicepeakToken != null
      ? settings.voicepeakToken
      : voicepeakTokenInput.value || ""
  ).trim();
  return { endpoint, token };
}

function buildVoicepeakRequestUrls(endpoint, reqPath) {
  const urls = [];
  const push = (base) => {
    try {
      urls.push(new URL(reqPath, base).toString());
    } catch (_) {
      // no-op
    }
  };

  push(endpoint);
  try {
    const parsed = new URL(endpoint);
    const host = String(parsed.hostname || "").toLowerCase();
    const port = parsed.port ? `:${parsed.port}` : "";
    const pathPrefix = parsed.pathname && parsed.pathname !== "/" ? parsed.pathname.replace(/\/+$/, "") : "";
    if (host === "127.0.0.1") {
      push(`${parsed.protocol}//localhost${port}${pathPrefix}`);
    } else if (host === "localhost") {
      push(`${parsed.protocol}//127.0.0.1${port}${pathPrefix}`);
    }
  } catch (_) {
    // no-op
  }

  return Array.from(new Set(urls));
}

async function callVoicepeakApi(settings, reqPath, method, body) {
  const connection = getVoicepeakConnection(settings);
  const headers = {
    "content-type": "application/json",
  };
  if (connection.token) {
    headers["x-web-reader-token"] = connection.token;
  }

  const urls = buildVoicepeakRequestUrls(connection.endpoint, reqPath);
  let response = null;
  let lastFetchError = null;

  for (const url of urls) {
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
      lastFetchError = null;
      break;
    } catch (error) {
      lastFetchError = error;
    }
  }

  if (!response) {
    const message = asErrorMessage(lastFetchError);
    throw new Error(
      `Voicepeak endpoint unreachable. Tried: ${urls.join(", ")}. Ensure local server is running and Safari local HTTP access is enabled (${message}).`
    );
  }

  let json = null;
  try {
    json = await response.json();
  } catch (_) {
    // no-op
  }

  if (!response.ok || !json || !json.ok) {
    const error = json && json.error ? json.error : `Voicepeak endpoint error (${response.status}).`;
    throw new Error(error);
  }

  return json;
}

async function speakInVoicepeak(settings, payload) {
  const json = await callVoicepeakApi(settings, "/api/speak", "POST", payload);
  playerState = normalizePlayerState(json.state || PLAYER_STATE.PLAYING);
  const queuedId = normalizeJobId(json.job_id || json.active_job_id);
  if (queuedId != null) {
    lastVoicepeakQueuedJobId = queuedId;
  }
  return json;
}

async function stopVoicepeak(settings) {
  const json = await callVoicepeakApi(settings, "/api/stop", "POST", {});
  playerState = inferVoicepeakState(json);
  lastVoicepeakQueuedJobId = null;
  return json;
}

async function pauseVoicepeak(settings) {
  const json = await callVoicepeakApi(settings, "/api/pause", "POST", {});
  playerState = normalizePlayerState(json.state || PLAYER_STATE.PAUSED);
  return json;
}

async function resumeVoicepeak(settings) {
  const json = await callVoicepeakApi(settings, "/api/resume", "POST", {});
  playerState = normalizePlayerState(json.state || PLAYER_STATE.PLAYING);
  return json;
}

async function refreshVoicepeakPlayerState(settings) {
  try {
    const json = await callVoicepeakApi(settings, "/api/status", "GET");
    playerState = inferVoicepeakState(json);
    maybeShowVoicepeakFailure(json);
  } catch (_) {
    playerState = PLAYER_STATE.IDLE;
  }
  setPlayPauseButtonByState();
}

async function refreshEnginePlayerState(settings) {
  const engine = settings && settings.engine ? settings.engine : engineSelect.value;
  if (engine === "voicepeak") {
    await refreshVoicepeakPlayerState(settings);
    return;
  }
  await refreshBrowserPlayerState();
}

async function startPlayback(mode, settings) {
  const tab = await requireActiveHttpTab();

  const extracted =
    mode === "auto" ? await extractTextAuto(tab.id) : await extractText(tab.id, mode);
  const effectiveMode = mode === "auto" ? extracted.mode || "page" : mode;
  const text = String(extracted.text || "");

  if (settings.engine === "voicepeak") {
    const result = await speakInVoicepeak(settings, {
      text,
      source: {
        mode: effectiveMode,
        url: tab.url || null,
        title: tab.title || null,
      },
    });

    const queue = Number(result.queue_length || 0);
    const queuedId = normalizeJobId(result.job_id || result.active_job_id);
    if (queuedId != null) {
      setStatus(`Queued to Voicepeak (job: ${queuedId}, queue: ${queue}).`, "ok");
    } else {
      setStatus(`Queued to Voicepeak (queue: ${queue}).`, "ok");
    }
    return;
  }

  const speech = await speakInBrowser(tab.id, text, settings);
  const chars = speech.chars || extracted.chars || 0;
  const chunks = speech.chunks || 0;
  if (speech && speech.transport === "popup_local") {
    setStatus(`Started (${chars} chars / ${chunks} chunks). Keep popup open in Safari.`, "ok");
    return;
  }
  if (speech && speech.transport === "tab_local") {
    setStatus(`Started (${chars} chars / ${chunks} chunks).`, "ok");
    return;
  }
  setStatus(`Started (${chars} chars / ${chunks} chunks).`, "ok");
}

async function runPlayPause() {
  if (isBusy) {
    return;
  }

  setBusyState(true);
  try {
    const settings = await saveSettings();

    if (settings.engine === "browser") {
      await refreshBrowserPlayerState();

      if (playerState === PLAYER_STATE.PLAYING) {
        await pauseBrowserPlayback();
        setStatus("Paused.", "ok");
      } else if (playerState === PLAYER_STATE.PAUSED) {
        await resumeBrowserPlayback();
        setStatus("Resumed.", "ok");
      } else {
        await startPlayback("auto", settings);
      }
    } else {
      await refreshVoicepeakPlayerState(settings);
      if (playerState === PLAYER_STATE.PLAYING) {
        await pauseVoicepeak(settings);
        setStatus("Paused.", "ok");
      } else if (playerState === PLAYER_STATE.PAUSED) {
        await resumeVoicepeak(settings);
        setStatus("Resumed.", "ok");
      } else {
        await startPlayback("auto", settings);
      }
    }
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    setStatus(message, "error");
  } finally {
    setBusyState(false);
    await refreshEnginePlayerState();
  }
}

async function runReset() {
  if (isBusy) {
    return;
  }

  setBusyState(true);
  try {
    const settings = await saveSettings();
    const tab = await getActiveTab();

    try {
      await stopBrowserPlayback();
    } catch (_) {
      // ignore background/offscreen reachability errors during reset
    }

    if (tab && typeof tab.id === "number") {
      try {
        await sendToTab(tab.id, { type: "WEB_READER_STOP" });
      } catch (_) {
        // ignore content-script reachability errors during reset
      }
    }

    if (settings.engine === "voicepeak") {
      try {
        await stopVoicepeak(settings);
      } catch (_) {
        // keep reset idempotent; browser stop already issued
      }
    }

    setStatus("Reset.", "ok");
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    setStatus(message, "error");
  } finally {
    setBusyState(false);
    await refreshEnginePlayerState();
  }
}

function onSettingsChanged() {
  saveSettings()
    .then((settings) => refreshEnginePlayerState(settings))
    .catch(() => {
      setStatus("Failed to save settings.", "error");
    });
}

engineSelect.addEventListener("change", onSettingsChanged);
voicepeakEndpointInput.addEventListener("change", onSettingsChanged);
voicepeakTokenInput.addEventListener("change", onSettingsChanged);
rateInput.addEventListener("change", onSettingsChanged);
pitchInput.addEventListener("change", onSettingsChanged);
volumeInput.addEventListener("change", onSettingsChanged);
maxCharsInput.addEventListener("change", onSettingsChanged);
chunkCharsInput.addEventListener("change", onSettingsChanged);

playPauseBtn.addEventListener("click", runPlayPause);
resetBtn.addEventListener("click", runReset);

loadSettings()
  .then(async () => {
    setStatus("Ready.");
    await refreshEnginePlayerState();
    window.setInterval(() => {
      refreshEnginePlayerState().catch(() => {
        // no-op
      });
    }, PLAYER_STATUS_POLL_MS);
  })
  .catch(() => setStatus("Failed to load settings.", "error"));
