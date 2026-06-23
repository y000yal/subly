// Minimal always-injected stub. Activation no longer flows through here — the
// background injects engine.js directly via executeScript({files}). This stub's
// only jobs are (1) mirroring the diagnostics trail into a hidden DOM node in
// the top frame so a session running in a cross-origin child frame is still
// inspectable from DevTools, and (2) a guarded test hook so automation can
// trigger the real toggle flow without clicking the toolbar.

import { isExtensionMessage } from '@/shared/messages';

export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  runAt: 'document_idle',
  matchOriginAsFallback: true,
  main() {
    // ---- diagnostics mirror (top frame only) ----
    const diagEvents: unknown[] = [];
    function appendDiag(events: unknown[]): void {
      diagEvents.push(...events);
      if (diagEvents.length > 300) diagEvents.splice(0, diagEvents.length - 300);
      try {
        let node = document.getElementById('__captiv_diag');
        if (!node) {
          node = document.createElement('script');
          node.id = '__captiv_diag';
          node.setAttribute('type', 'application/json');
          node.setAttribute('data-captiv', 'diag');
          document.documentElement.appendChild(node);
        }
        node.textContent = JSON.stringify(diagEvents);
      } catch {
        // document not ready — events stay buffered in memory
      }
    }

    chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
      if (!isExtensionMessage(msg)) return;
      if (msg.t === 'diag/trail' && window === window.top) {
        appendDiag(msg.events);
        sendResponse({ ok: true });
      }
      return undefined;
    });

    // ---- test/e2e activation hook ----
    // Lets automation trigger the REAL activation (full background election,
    // same as the toolbar) from an in-page event, since automation cannot click
    // the toolbar or fire chrome.commands. A genuine user click must precede the
    // event so transient activation is live. Enabled on loopback always, or when
    // the page opted in via localStorage.captivTestHook = '1'.
    let testHookEnabled =
      location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    try {
      if (localStorage.getItem('captivTestHook') === '1') testHookEnabled = true;
    } catch {
      // sandboxed frame without storage access
    }
    if (testHookEnabled) {
      window.addEventListener('CAPTIV_TEST_ACTIVATE', () => {
        void chrome.runtime.sendMessage({ t: 'test/toggle' }).catch(() => {});
      });
    }
  },
});
