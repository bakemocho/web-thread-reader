# CWS Review Notes

Single purpose:

- Extract readable text from the active page and read it aloud when user starts playback.

Permission usage:

- `activeTab`: run on user-invoked tab only.
- `scripting`: text extraction execution.
- `storage`: save local settings.
- `tabs`: tab lookup and playback state coordination.
- `offscreen`: keep Browser TTS playback across navigation.
- `host_permissions`: read page DOM on supported pages.

Privacy model:

- No autonomous browsing actions.
- No posting/liking/following.
- No remote data transfer by default.
- Optional localhost integration only when user enables Voicepeak companion mode.
