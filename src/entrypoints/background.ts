// Thin coordinator. Owns activation (toolbar click / Alt+P), the cross-frame
// candidate election, and a per-tab session registry for toggling and badge.
// All DOM work happens in content scripts; this worker never touches video.

import type {
  ContentToBgMessage,
  FrameScanResult,
  PipTier,
  SessionState,
  VideoCandidateInfo,
} from '@/shared/messages';
import { isExtensionMessage } from '@/shared/messages';
import type { DiagEvent } from '@/shared/diag';
import { createLogger } from '@/shared/logger';

const log = createLogger('bg');

interface TabSession {
  sessionId: string;
  frameId: number;
  state: SessionState;
}

export default defineBackground(() => {
  const sessions = new Map<number, TabSession>();

  chrome.action.setBadgeBackgroundColor({ color: '#1d4ed8' });

  chrome.action.onClicked.addListener((tab) => void toggle(tab));
  chrome.commands.onCommand.addListener((command, tab) => {
    if (command === 'toggle-pip' && tab?.id != null) void toggle(tab);
  });

  chrome.runtime.onMessage.addListener((msg: unknown, sender) => {
    if (!isExtensionMessage(msg)) return;
    const tabId = sender.tab?.id;
    if (tabId == null) return;
    if ((msg as ContentToBgMessage).t === 'test/toggle') {
      if (sender.tab) void toggle(sender.tab);
      return;
    }
    handleContentMessage(msg as ContentToBgMessage, tabId, sender.frameId ?? 0);
  });

  chrome.tabs.onRemoved.addListener((tabId) => sessions.delete(tabId));
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    // Full navigation kills the content script; Chrome closes the Doc PiP
    // window with its opener. Just drop our bookkeeping.
    if (info.status === 'loading' && sessions.has(tabId)) {
      sessions.delete(tabId);
      void setBadge(tabId, '');
    }
  });

  function handleContentMessage(msg: ContentToBgMessage, tabId: number, frameId: number) {
    if (msg.t === 'session/state') {
      if (msg.state === 'idle' || msg.state === 'failed') {
        sessions.delete(tabId);
        void setBadge(tabId, '');
      } else {
        sessions.set(tabId, { sessionId: msg.sessionId, frameId, state: msg.state });
        void setBadge(tabId, msg.state.startsWith('active') ? 'ON' : '');
      }
    } else if (msg.t === 'session/error') {
      log.warn('session error', msg.code, msg.detail);
      bgDiag(tabId, 'session/error', { code: msg.code, detail: msg.detail });
      sessions.delete(tabId);
      void flashBadge(tabId, '!');
    } else if (msg.t === 'diag/event') {
      relayDiag(tabId, msg.event);
    }
  }

  // ---- diagnostics trail: buffer per tab, mirror into the top frame ----
  function relayDiag(tabId: number, event: DiagEvent): void {
    chrome.tabs
      .sendMessage(tabId, { t: 'diag/trail', events: [event] }, { frameId: 0 })
      .catch(() => {});
  }

  function bgDiag(tabId: number, stage: string, data?: unknown): void {
    relayDiag(tabId, { ts: Date.now(), ctx: 'bg', stage, data });
  }

  async function toggle(tab: chrome.tabs.Tab): Promise<void> {
    const tabId = tab.id;
    if (tabId == null) return;

    const existing = sessions.get(tabId);
    if (existing) {
      sessions.delete(tabId);
      void setBadge(tabId, '');
      try {
        // executeScript, not messaging: sandboxed/opaque-origin player frames
        // never get the declared stub, so they have no message listener.
        await chrome.scripting.executeScript({
          target: { tabId, frameIds: [existing.frameId] },
          func: stopInjected,
        });
      } catch (err) {
        log.warn('stop injection failed (frame gone?)', err);
      }
      return;
    }

    // Load the engine into every frame as a FILE. This is the reliable path
    // under activeTab (with no declared content script): executeScript({files})
    // runs the self-registering engine chunk in each frame's isolated world,
    // setting globalThis.__pipEngine. registerEngine() is idempotent, so a frame
    // that already has it is a no-op. Dynamic import() inside an injected func is
    // unreliable, which is why we inject the file directly instead.
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: ['engine.js'],
      });
    } catch (err) {
      log.warn('cannot inject into this page', err);
      void flashBadge(tabId, '!');
      return;
    }

    // Scan every frame. executeScript also carries the user gesture into each
    // frame's document (required later for requestWindow/requestPictureInPicture)
    // and returns each frame's candidates directly.
    let results: chrome.scripting.InjectionResult[];
    try {
      results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: scanFrame,
      });
    } catch (err) {
      log.warn('scan injection failed', err);
      void flashBadge(tabId, '!');
      return;
    }

    log.warn(
      'SCAN DEBUG ' +
        JSON.stringify(results.map((r) => ({ frameId: r.frameId, result: r.result }))),
    );

    bgDiag(tabId, 'scan/results', {
      frames: results.map((r) => {
        const s = r.result as FrameScanResult | null | undefined;
        return {
          frameId: r.frameId,
          isTop: s?.isTop,
          covered: s?.coveredByParent,
          candidates: s?.candidates?.map((c) => ({
            id: c.candidateId,
            score: c.score,
            playing: c.playing,
            tracks: c.hasTextTracks,
            drm: c.drmSuspected,
          })),
        };
      }),
    });

    const winner = elect(results);
    if (!winner) {
      bgDiag(tabId, 'scan/no-video');
      void flashBadge(tabId, '0');
      void showToast(tabId, 'Captiv: no video found on this page.');
      return;
    }

    const sessionId = `s${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    // Always use the canvas/native tier so every site (top-frame like YouTube
    // and cross-origin iframes like flixmomo) gets the same native PiP window
    // with Chrome-drawn controls. Subtitles are burned into the canvas.
    const tier: PipTier = 'canvas';
    bgDiag(tabId, 'elect/winner', {
      sessionId,
      frameId: winner.frameId,
      isTop: winner.isTop,
      candidateId: winner.candidate.candidateId,
      tier,
    });
    sessions.set(tabId, { sessionId, frameId: winner.frameId, state: 'starting' });
    void setBadge(tabId, '…');

    try {
      // executeScript instead of messaging: reaches frames the declared stub
      // can't (sandboxed iframes), and re-extends the user-gesture grant into
      // the frame right before requestWindow/requestPictureInPicture run.
      const [result] = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [winner.frameId] },
        func: startInjected,
        args: [sessionId, winner.candidate.candidateId, tier],
      });
      const outcome = result?.result as { ok: boolean; error?: string } | undefined;
      if (!outcome?.ok) throw new Error(outcome?.error ?? 'start returned no result');
      bgDiag(tabId, 'start/dispatched', { frameId: winner.frameId });
    } catch (err) {
      log.error('pip/start failed', err);
      bgDiag(tabId, 'start/failed', { err: String(err) });
      sessions.delete(tabId);
      void flashBadge(tabId, '!');
    }
  }

  function elect(
    results: chrome.scripting.InjectionResult[],
  ): { frameId: number; isTop: boolean; candidate: VideoCandidateInfo } | null {
    const all: { frameId: number; isTop: boolean; candidate: VideoCandidateInfo }[] = [];
    for (const r of results) {
      const scan = r.result as FrameScanResult | null | undefined;
      if (!scan || scan.coveredByParent) continue;
      for (const candidate of scan.candidates) {
        all.push({ frameId: r.frameId, isTop: scan.isTop, candidate });
      }
    }
    all.sort((a, b) => {
      if (a.candidate.playing !== b.candidate.playing) return a.candidate.playing ? -1 : 1;
      if (a.candidate.score !== b.candidate.score) return b.candidate.score - a.candidate.score;
      if (a.isTop !== b.isTop) return a.isTop ? -1 : 1;
      return 0;
    });
    return all[0] ?? null;
  }

  async function setBadge(tabId: number, text: string): Promise<void> {
    try {
      await chrome.action.setBadgeText({ tabId, text });
    } catch {
      // tab may be gone
    }
  }

  async function flashBadge(tabId: number, text: string): Promise<void> {
    await setBadge(tabId, text);
    setTimeout(() => void setBadge(tabId, ''), 4000);
  }

  async function showToast(tabId: number, text: string): Promise<void> {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, func: toastInjected, args: [text] });
    } catch {
      // page not scriptable
    }
  }
});

// ---- Injected functions (serialized — must be fully self-contained) ----

async function startInjected(
  sessionId: string,
  candidateId: string,
  tier: 'docpip' | 'canvas',
): Promise<{ ok: boolean; error?: string }> {
  const engine = globalThis.__pipEngine;
  if (!engine) return { ok: false, error: 'engine not loaded in winning frame' };
  try {
    await engine.start(sessionId, candidateId, tier);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

function stopInjected(): void {
  void globalThis.__pipEngine?.stop('user');
}

function scanFrame(): unknown {
  // The engine was injected as a file immediately before this call, so it is
  // already registered on globalThis in this frame's isolated world.
  const isTop = window === window.top;
  const engine = globalThis.__pipEngine;
  const dbg = {
    hasEngine: Boolean(engine),
    rawVideos: document.querySelectorAll('video').length,
    href: location.href.slice(0, 120),
  };
  if (engine) {
    try {
      return { ...engine.scan(), __dbg: dbg };
    } catch (e) {
      return { candidates: [], isTop, coveredByParent: false, __dbg: { ...dbg, err: String(e) } };
    }
  }
  return { candidates: [], isTop, coveredByParent: false, __dbg: dbg };
}

function toastInjected(text: string): void {
  const id = '__captiv_toast';
  document.getElementById(id)?.remove();
  const el = document.createElement('div');
  el.id = id;
  el.textContent = text;
  el.style.cssText =
    'position:fixed;z-index:2147483647;right:16px;bottom:16px;max-width:340px;' +
    'background:#111827;color:#f9fafb;font:13px/1.4 system-ui,sans-serif;' +
    'padding:10px 14px;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.4);';
  document.documentElement.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}
