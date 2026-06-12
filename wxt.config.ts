import { defineConfig } from 'wxt';

// Manifest V3, Chrome-only (Document Picture-in-Picture requires Chromium 116+).
export default defineConfig({
  srcDir: 'src',
  publicDir: 'src/public',
  outDir: '.output',
  manifest: {
    name: 'Subly — PiP with Subtitles That Just Works',
    short_name: 'Subly',
    description:
      "Watch any video in Picture-in-Picture with the site's own subtitles shown in the floating window. Works on every site.",
    minimum_chrome_version: '116',
    permissions: ['scripting', 'storage', 'activeTab'],
    action: {
      default_title: 'Toggle Picture-in-Picture with subtitles (Alt+P)',
    },
    commands: {
      'toggle-pip': {
        suggested_key: { default: 'Alt+P' },
        description: 'Toggle Picture-in-Picture with subtitles',
      },
    },
    web_accessible_resources: [
      {
        // The lazily-imported engine chunk, loaded by the content stub on activation.
        resources: ['engine.js'],
        matches: ['<all_urls>'],
      },
    ],
  },
});
