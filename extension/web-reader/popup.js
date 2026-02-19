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

async function extractText(tabId, mode) {
  const type = mode === "x" ? "WEB_READER_EXTRACT_X" : "WEB_READER_EXTRACT_PAGE";
  const response = await sendToTab(tabId, { type });
  if (!response || !response.ok) {
    throw new Error(response && response.error ? response.error : "Failed to extract text.");
  }
  return response;
}

async function extractTextAuto(tabId) {
  const xResponse = await sendToTab(tabId, { type: "WEB_READER_EXTRACT_X" });
  if (xResponse && xResponse.ok) {
    return {
      ...xResponse,
      mode: "x",
    };
  }

  const pageResponse = await sendToTab(tabId, { type: "WEB_READER_EXTRACT_PAGE" });
  if (pageResponse && pageResponse.ok) {
    return {
      ...pageResponse,
      mode: "page",
    };
  }

  const error =
    (xResponse && xResponse.error) ||
    (pageResponse && pageResponse.error) ||
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

async function speakInBrowser(text, settings) {
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
}

async function pauseBrowserPlayback() {
  const response = await sendToBackground(
    { type: "WEB_READER_BG_PAUSE" },
    "Browser pause failed."
  );
  playerState = normalizePlayerState(response.state || PLAYER_STATE.PAUSED);
  return response;
}

async function resumeBrowserPlayback() {
  const response = await sendToBackground(
    { type: "WEB_READER_BG_RESUME" },
    "Browser resume failed."
  );
  playerState = normalizePlayerState(response.state || PLAYER_STATE.PLAYING);
  return response;
}

async function stopBrowserPlayback() {
  const response = await sendToBackground(
    { type: "WEB_READER_BG_STOP" },
    "Browser stop failed."
  );
  playerState = normalizePlayerState(response.state || PLAYER_STATE.IDLE);
  return response;
}

async function refreshBrowserPlayerState() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "WEB_READER_BG_STATUS" });
    if (response && response.ok && typeof response.state === "string") {
      playerState = normalizePlayerState(response.state);
    } else {
      playerState = PLAYER_STATE.IDLE;
    }
  } catch (_) {
    playerState = PLAYER_STATE.IDLE;
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

async function callVoicepeakApi(settings, reqPath, method, body) {
  const connection = getVoicepeakConnection(settings);
  const headers = {
    "content-type": "application/json",
  };
  if (connection.token) {
    headers["x-web-reader-token"] = connection.token;
  }

  const response = await fetch(`${connection.endpoint}${reqPath}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

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
  return json;
}

async function stopVoicepeak(settings) {
  const json = await callVoicepeakApi(settings, "/api/stop", "POST", {});
  playerState = inferVoicepeakState(json);
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
    setStatus(`Queued to Voicepeak (queue: ${queue}).`, "ok");
    return;
  }

  const speech = await speakInBrowser(text, settings);
  const chars = speech.chars || extracted.chars || 0;
  const chunks = speech.chunks || 0;
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
