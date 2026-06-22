import { defineConfig } from 'wxt';

// Manifest V3, Chrome-only (Document Picture-in-Picture requires Chromium 116+).
export default defineConfig({
  srcDir: 'src',
  publicDir: 'src/public',
  outDir: '.output',
  manifest: {
    name: 'Captiv — PiP with Subtitles That Just Works',
    short_name: 'Captiv',
    description:
      "Watch any video in Picture-in-Picture with the site's own subtitles shown in the floating window. Works on every site.",
    minimum_chrome_version: '116',
    permissions: ['scripting', 'storage'],
    // Broad host access is required for the product's single purpose: detect the
    // video and mirror the site's enabled subtitles on any page, INCLUDING players
    // embedded in cross-origin iframes. activeTab is insufficient — it only
    // authorizes the top frame's origin, so executeScript({allFrames}) silently
    // skips cross-origin player frames (confirmed: the video frame is never
    // reached). With <all_urls>, executeScript reaches every frame on activation.
    // Nothing is injected until the user clicks the toolbar button or presses Alt+P.
    host_permissions: ['<all_urls>'],
    action: {
      default_title: 'Toggle Picture-in-Picture with subtitles (Alt+P)',
    },
    commands: {
      'toggle-pip': {
        suggested_key: { default: 'Alt+P' },
        description: 'Toggle Picture-in-Picture with subtitles',
      },
    },
    // No web_accessible_resources: the engine chunk is injected on activation via
    // chrome.scripting.executeScript({ files: ['engine.js'] }), which loads it
    // into the frame's isolated world without exposing it to page contexts.
  },
});
