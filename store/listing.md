# Chrome Web Store listing (draft)

## Single purpose statement
Plays the current page's video in a Picture-in-Picture window with the site's own
enabled subtitles displayed in the floating window.

## Description (draft)
Subtitles disappear in Chrome's built-in Picture-in-Picture. PiP Subtitles fixes that —
on every site, not just a hardcoded list.

- Click the toolbar button or press Alt+P; the video pops out with its subtitles.
- Works with whatever subtitles the player already has enabled — native text tracks or
  site-rendered captions are detected automatically.
- Style your subtitles: size, font, colors, background, position, edge style.
- Playback controls in the PiP window: play/pause, seek, time, quick subtitle sizing.
- No data collected. Everything runs locally.

Not affiliated with any video site. The extension displays the site's own enabled
subtitles; it does not extract, translate, or download them.

## Permission justifications (Privacy practices tab)
- **Host permission `<all_urls>`**: Required by the single purpose — detect the video and
  mirror the site's enabled subtitles on whatever page the user activates the extension,
  including players embedded in cross-origin iframes. The injected component is a ~2 KB
  inert listener until the user clicks the toolbar icon or presses the shortcut.
- **scripting**: Injects the player/subtitle module into the current tab when (and only
  when) the user activates the extension; carrying the user gesture into the page is
  required by the Picture-in-Picture APIs.
- **storage**: Saves the user's subtitle style preferences (sync storage). No browsing
  data is stored.

## Data use certification
Collects nothing, transmits nothing, sells nothing. All processing is local.

## Assets checklist
- [ ] 128×128 icon (replace generated placeholder)
- [ ] 1–5 screenshots, 1280×800 — PiP window with subtitles over a generic page (no
      trademarked site branding)
- [ ] Small promo tile 440×280
- [ ] Privacy policy URL (see privacy-policy.md, host it anywhere public)
