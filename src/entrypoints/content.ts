// The always-injected stub. Kept intentionally tiny: one message listener,
// zero observers, zero DOM reads at idle. The full engine is a separate
// web-accessible chunk, dynamically imported on first activation.

import type { PipEngineGlobal } from '@/shared/globals';
import { isExtensionMessage } from '@/shared/messages';

export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  runAt: 'document_idle',
  matchOriginAsFallback: true,
  main() {
    let enginePromise: Promise<PipEngineGlobal> | null = null;

    function ensureEngine(): Promise<PipEngineGlobal> {
      const loaded = globalThis.__pipEngine;
      if (loaded) return Promise.resolve(loaded);
      enginePromise ??= import(/* @vite-ignore */ chrome.runtime.getURL('/engine.js')).then(() => {
        const engine = globalThis.__pipEngine;
        if (!engine) throw new Error('subly engine failed to register');
        return engine;
      });
      return enginePromise;
    }

    globalThis.__pipStub = {
      ensureEngine,
      scanForActivation: async () => (await ensureEngine()).scan(),
    };

    // Session start/stop are dispatched via chrome.scripting.executeScript
    // straight into the winning frame (sandboxed player iframes never get this
    // declared stub, so messaging can't be the control path). The stub's only
    // message duty is mirroring the diagnostics trail in the top frame.
    chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
      if (!isExtensionMessage(msg)) return;
      if (msg.t === 'diag/trail' && window === window.top) {
        appendDiag(msg.events);
        sendResponse({ ok: true });
      }
      return undefined;
    });

    // Diagnostics mirror: the background forwards every session diag event to
    // the top frame; we keep the last 300 in a hidden DOM node so the trail is
    // inspectable from DevTools on any page, even when the session lives in a
    // cross-origin child frame.
    const diagEvents: unknown[] = [];
    function appendDiag(events: unknown[]): void {
      diagEvents.push(...events);
      if (diagEvents.length > 300) diagEvents.splice(0, diagEvents.length - 300);
      try {
        let node = document.getElementById('__subly_diag');
        if (!node) {
          node = document.createElement('script');
          node.id = '__subly_diag';
          node.setAttribute('type', 'application/json');
          node.setAttribute('data-subly', 'diag');
          document.documentElement.appendChild(node);
        }
        node.textContent = JSON.stringify(diagEvents);
      } catch {
        // document not ready — events stay buffered in memory
      }
    }

    // E2E/debug hook: lets automation trigger the REAL activation flow (full
    // background election, same as the toolbar) from an in-page event, since
    // automation cannot click the toolbar or fire chrome.commands. A genuine
    // user click must precede the event so transient activation is live.
    // Attached on loopback hosts always; elsewhere only when the page origin
    // opted in via localStorage.pipTestHook = '1' (dev builds — strip before
    // store submission).
    let testHookEnabled = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    try {
      if (localStorage.getItem('pipTestHook') === '1') testHookEnabled = true;
    } catch {
      // sandboxed frame without storage access
    }
    if (testHookEnabled) {
      window.addEventListener('SUBLY_TEST_ACTIVATE', () => {
        void chrome.runtime.sendMessage({ t: 'test/toggle' }).catch(() => {});
      });
    }
  },
});
