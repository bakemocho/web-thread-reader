# Web Thread Reader (MV3)

Browser extension that reads text aloud from:

- generic web page main body
- X/Twitter status pages and X article pages

It supports two engines:

- Browser `SpeechSynthesis` (no cloud API required)
- Local Voicepeak bridge API (`tools/voicepeak-reader-server.js`)

## Install (Chromium)

1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select `/Users/bakemocho/gitwork_bk/jobhunt-portfolio/extension/web-reader`

## Usage

1. Open a target page
2. Click extension icon
3. Click `Play`:
   - on X/Twitter pages: detect longform article blocks in DOM and read them first, otherwise read tweet/thread text
   - on other URLs: extract and read generic page text
4. On Browser TTS and Voicepeak engines:
   - `Pause`: pause current speech
   - `Play` again: resume from paused position
5. `Reset` stops and clears current playback immediately

Browser TTS keeps speaking even if you navigate to another page, until `Reset` is pressed.

## Voicepeak mode (local)

1. Start local bridge server:

```bash
node /Users/bakemocho/gitwork_bk/jobhunt-portfolio/tools/voicepeak-reader-server.js
```

2. Open extension popup and set:
   - `Engine`: `Voicepeak (local)`
   - `Voicepeak API`: default `http://127.0.0.1:18766`
   - `API token`: optional (required only if server token auth is enabled)
3. Click `Play`.

Voicepeak bridge receives extracted text and runs `voicepeak-automation`.
Synthesis and playback are pipelined per chunk to reduce wait time.

## Settings

Popup settings are persisted in `chrome.storage.local`:

- `Engine`
- `Voicepeak API`
- `API token`
- `Rate`
- `Pitch`
- `Volume`
- `Max chars` (hard cap before reading)
- `Chunk chars` (speech chunk size)

## Notes

- On X pages, `さらに表示` / `Show more` buttons inside tweets are clicked before extraction.
- X extraction skips likely promoted/ad posts and unrelated "recommended" timeline items on status detail pages.
- X extraction reads tweet body text only (no user name / timestamp lines) when longform blocks are not present.
- Longform article extraction prioritizes `twitterArticleRichTextView`/`longformRichTextComponent` blocks.
- Article/thread selection is based on detected DOM structure, not URL path patterns.
- Browser TTS runs in an offscreen extension document, so playback is independent from tab navigation.
- Play/Pause resume behavior is available on both Browser TTS and Voicepeak (local bridge) engines.
- Extraction is heuristic; complex layouts may include extra lines or miss some blocks.
- This extension is passive (user-triggered only), not autonomous browsing.
