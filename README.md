# web-thread-reader

Browser extension that reads webpage text and X (Twitter) article/thread content aloud.

## Scope

- Browser extension runtime: `extension/web-reader`
- Engine options:
  - Browser TTS (`SpeechSynthesis`)
  - Optional local Voicepeak companion bridge

## Why this repo is separate

This repo contains only the reading extension and publishable docs.
Capture logic and personal workflows are intentionally excluded.

Related repos:

- Voicepeak automation runtime: <https://github.com/bakemocho/voicepeak-automation>
- X capture toolkit: <https://github.com/bakemocho/x-capture-kit>

## Install (Chromium)

1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select `extension/web-reader`

## Voicepeak companion mode (optional)

By default, the extension works with Browser TTS only.
If you want Voicepeak playback, run a local companion API that bridges to `voicepeak-automation`.

Current implementation reference (from private workspace history):

- local bridge API behavior and request schema are described in docs/chrome-web-store notes

## Project layout

```text
web-thread-reader/
  README.md
  LICENSE
  LEGAL.md
  extension/
    web-reader/
      manifest.json
      background.js
      content-script.js
      popup.html
      popup.js
      popup.css
      offscreen.html
      offscreen.js
  docs/
    chrome-web-store/
      listing-ja.md
      listing-en.md
      review-notes.md
      release-checklist.md
```

## Publishing

- Draft listing copy and review notes live under `docs/chrome-web-store/`.
- Start with CWS `Unlisted`, then switch to `Public` after review and real-world checks.

## License

MIT (`LICENSE`).
Usage and legal notes are in `LEGAL.md`.
