# Chrome Web Store Listing Copy (English)

Last updated: 2026-02-19

## Base Info

- Extension name: `Web Thread Reader`
- Category: `Productivity`
- Language: `English`

## Short Description (<=132 chars)

Read web page body text and X article/thread text aloud with Browser TTS or optional local Voicepeak integration.

## Full Description

Web Thread Reader extracts readable text from the current page and plays it as speech.

Key features:

- Read main content on general web pages
- Read X (x.com / twitter.com) article and thread content
- Choose Browser TTS or local Voicepeak integration
- Play / Pause / Reset controls
- Browser TTS playback can continue after tab navigation

On X pages, the extension prioritizes article-rich text blocks and reduces noisy reads such as promoted/recommended timeline items.

This extension is passive and user-triggered only. It does not auto-post, auto-like, auto-follow, or autonomously browse.

## Single Purpose Description (review field)

Extract readable text from the active page (general web/X) and read it aloud locally when the user starts playback.

## Privacy Practices (draft answers)

- Sells user data: No
- Transfers user data to third parties: No
- Collects credentials: No
- Sends page content externally by default: No
- Optional integration: local Voicepeak API on localhost only when configured by the user

## Permission Justification (review note)

- `activeTab`: run extraction only on the user-invoked tab
- `scripting`: execute extraction scripts
- `storage`: persist user settings
- `tabs`: resolve target tab and control playback state
- `offscreen`: keep Browser TTS playback across tab navigation
- `host_permissions`: read DOM on supported pages when user triggers extraction

## What’s New (initial/latest release)

- Skip promoted/recommended posts during X reading
- Improved X article extraction stability
- Improved Play/Pause/Reset interaction flow

## Store Listing Fields to Fill

- Support URL: `https://github.com/bakemocho/web-thread-reader/issues`
- Homepage URL: `https://github.com/bakemocho/web-thread-reader`
- Privacy Policy URL: `https://github.com/bakemocho/web-thread-reader/blob/main/LEGAL.md`
