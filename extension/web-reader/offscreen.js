"use strict";

const DEFAULT_SETTINGS = {
  rate: 1,
  pitch: 1,
  volume: 1,
  maxChars: 8000,
  chunkChars: 180,
};

const PLAYER_IDLE_STATE = {
  state: "idle",
  chars: 0,
  chunks: 0,
  lang: null,
};

let sessionId = 0;
let playerState = { ...PLAYER_IDLE_STATE };

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
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

function splitIntoChunks(text, chunkChars) {
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
      for (let i = 0; i < sentence.length; i += maxLen) {
        chunks.push(sentence.slice(i, i + maxLen));
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
  const voices = window.speechSynthesis.getVoices();
  if (!Array.isArray(voices) || voices.length === 0) {
    return null;
  }

  const exact = voices.find((voice) => String(voice.lang || "").toLowerCase() === lang.toLowerCase());
  if (exact) {
    return exact;
  }

  const prefix = voices.find((voice) => String(voice.lang || "").toLowerCase().startsWith(lang.slice(0, 2).toLowerCase()));
  if (prefix) {
    return prefix;
  }

  return voices[0] || null;
}

function snapshotPlayerState() {
  return { ...playerState };
}

function markIdleState() {
  playerState = { ...PLAYER_IDLE_STATE };
}

function setPlayerState(partial) {
  playerState = {
    ...playerState,
    ...partial,
  };
}

function stopSpeaking() {
  sessionId += 1;
  window.speechSynthesis.cancel();
  markIdleState();
}

function pauseSpeaking() {
  if (playerState.state !== "playing") {
    return { ok: false, error: "Browser TTS is not playing." };
  }
  if (!window.speechSynthesis.speaking && !window.speechSynthesis.pending) {
    return { ok: false, error: "No active browser playback." };
  }

  window.speechSynthesis.pause();
  setPlayerState({ state: "paused" });
  return {
    ok: true,
    ...snapshotPlayerState(),
  };
}

function resumeSpeaking() {
  if (playerState.state !== "paused") {
    return { ok: false, error: "Browser TTS is not paused." };
  }

  window.speechSynthesis.resume();
  setPlayerState({ state: "playing" });
  return {
    ok: true,
    ...snapshotPlayerState(),
  };
}

function startSpeaking(text, settings) {
  const mergedSettings = {
    ...DEFAULT_SETTINGS,
    ...(settings || {}),
  };

  const normalized = normalizeSpaces(text).slice(0, mergedSettings.maxChars);
  if (!normalized) {
    return { ok: false, error: "No readable text found." };
  }

  const chunks = splitIntoChunks(normalized, mergedSettings.chunkChars);
  if (chunks.length === 0) {
    return { ok: false, error: "No readable text found." };
  }

  stopSpeaking();
  const activeSession = sessionId;
  const lang = isJapaneseText(normalized) ? "ja-JP" : "en-US";
  const voice = pickVoice(lang);

  setPlayerState({
    state: "playing",
    chars: normalized.length,
    chunks: chunks.length,
    lang,
  });

  let index = 0;
  const speakNext = () => {
    if (activeSession !== sessionId) {
      return;
    }
    if (index >= chunks.length) {
      markIdleState();
      return;
    }

    const utterance = new SpeechSynthesisUtterance(chunks[index]);
    utterance.lang = lang;
    utterance.rate = clamp(Number(mergedSettings.rate) || DEFAULT_SETTINGS.rate, 0.5, 2);
    utterance.pitch = clamp(Number(mergedSettings.pitch) || DEFAULT_SETTINGS.pitch, 0, 2);
    utterance.volume = clamp(Number(mergedSettings.volume) || DEFAULT_SETTINGS.volume, 0, 1);
    if (voice) {
      utterance.voice = voice;
    }

    utterance.onend = () => {
      if (activeSession !== sessionId) {
        return;
      }
      index += 1;
      if (index >= chunks.length) {
        markIdleState();
        return;
      }
      speakNext();
    };
    utterance.onerror = () => {
      if (activeSession !== sessionId) {
        return;
      }
      index += 1;
      if (index >= chunks.length) {
        markIdleState();
        return;
      }
      speakNext();
    };

    window.speechSynthesis.speak(utterance);
  };

  speakNext();

  return {
    ok: true,
    ...snapshotPlayerState(),
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  try {
    if (!message || !message.type) {
      sendResponse({ ok: false, error: "Invalid command." });
      return false;
    }

    if (message.type === "WEB_READER_OFFSCREEN_SPEAK") {
      sendResponse(startSpeaking(message.text, message.settings));
      return false;
    }

    if (message.type === "WEB_READER_OFFSCREEN_STOP") {
      stopSpeaking();
      sendResponse({ ok: true, ...snapshotPlayerState() });
      return false;
    }

    if (message.type === "WEB_READER_OFFSCREEN_PAUSE") {
      sendResponse(pauseSpeaking());
      return false;
    }

    if (message.type === "WEB_READER_OFFSCREEN_RESUME") {
      sendResponse(resumeSpeaking());
      return false;
    }

    if (message.type === "WEB_READER_OFFSCREEN_STATUS") {
      sendResponse({ ok: true, ...snapshotPlayerState() });
      return false;
    }

    return false;
  } catch (error) {
    sendResponse({
      ok: false,
      error: error && error.message ? error.message : String(error),
    });
    return false;
  }
});
