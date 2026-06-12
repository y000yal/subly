# PiP Subtitles

Chrome extension (Manifest V3): watch any page's video in Picture-in-Picture with the
site's own subtitles shown in the floating window. Universal by design — no per-site
adapters, only generic mechanisms.

## How it works

| Tier | When | Mechanism | Subtitles |
|---|---|---|---|
| 1 | Video in the top frame (or a same-origin iframe) | Document Picture-in-Picture: the **real `<video>` element** is moved into a PiP window we own (DRM-safe) | Rendered in our overlay |
| 2 | Video in a cross-origin iframe | Canvas compositor inside the iframe → `captureStream()` → native PiP | Burned into the frames |
| 3 | DRM video in a cross-origin iframe | Plain native PiP + honest toast | None |

Subtitles are captured from two generic sources, arbitrated by live confidence:

- **TextTracks** (`cuechange`/`activeCues`, including `hidden` tracks that players like
  hls.js/Shaka/Video.js render themselves)
- **DOM overlay heuristics** (geometry over the video, text shape, mutation cadence,
  `caption|subtitle|cue` class patterns, `aria-live`) — covers YouTube/Netflix-style
  page-rendered captions

## Architecture

- `src/entrypoints/background.ts` — activation (toolbar / Alt+P), cross-frame candidate
  election, per-tab session registry. Activation always flows through
  `chrome.scripting.executeScript` so the user gesture reaches the page (required by
  `documentPictureInPicture.requestWindow`).
- `src/entrypoints/content.ts` — ~2 KB always-injected stub; zero idle cost.
- `src/entrypoints/engine.ts` → `src/engine/` — the lazily-imported engine chunk
  (web-accessible `/engine.js`): video detection, subtitle capture, PiP tiers, session.
- `src/entrypoints/options/` — subtitle appearance settings with live preview
  (`chrome.storage.sync`, applied live to open PiP windows).

## Develop

```sh
npm install
npm run dev      # WXT dev mode with reload
npm run build    # production build into .output/chrome-mv3
npm run compile  # strict tsc check
```

Load unpacked: `chrome://extensions` → Developer mode → "Load unpacked" →
`.output/chrome-mv3`.

## Test

```sh
npm run fixtures   # serves tests/fixtures on http://localhost:8901
```

- `texttrack.html` — synthetic video + programmatic TextTrack (tier 1, TextTrack source)
- `dom-overlay.html` — page-rendered caption divs (tier 1, DOM-overlay source)
- `iframe-embed.html` — cross-origin iframe via localhost vs 127.0.0.1 (tier 2, canvas)

Each fixture has an "Activate PiP (test hook)" button — the stub listens for a
`PIPSUBS_TEST_ACTIVATE` event on loopback hosts only, so automation can trigger PiP from
a genuine in-page click. On real sites, use the toolbar button or Alt+P.

Manual matrix before release: YouTube, Netflix (DRM + DOM captions), Twitch,
MDN `<track>` sample, hls.js/Shaka/Video.js demos, a Vimeo embed on a third-party page,
SPA navigation while in PiP, fullscreen round-trip, live stream.

## Store submission

See `store/` for the listing copy, permission justifications, and privacy policy.
Replace the generated placeholder icons (`npm run icons`) with designed ones first.
