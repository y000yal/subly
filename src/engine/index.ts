// Engine bootstrap. The stub (or an injected scan function) dynamic-imports
// this chunk; it registers a single per-frame API on globalThis and keeps at
// most one live session per frame.

import type { PipEngineGlobal } from '@/shared/globals';
import { resolveCandidate, scanFrame } from './detect/video-detector';
import { PipSession } from './session';
import { DomOverlaySource } from './subtitles/dom-overlay-source';
import type { SubtitleCue } from './subtitles/types';
import { createLogger } from '@/shared/logger';
import { diag } from '@/shared/diag';

const log = createLogger('engine');

// Below this footprint a frame has no real embedded player to scope captions
// to, so relaying from it would surface unrelated page text.
const RELAY_MIN_PLAYER_AREA = 50_000;

export function registerEngine(): void {
  if (globalThis.__pipEngine) return;

  let current: PipSession | null = null;
  let relay: DomOverlaySource | null = null;

  const api: PipEngineGlobal = {
    scan: scanFrame,

    async start(sessionId, candidateId, tier) {
      if (current) {
        await current.stop('replaced');
        current = null;
      }
      const video = resolveCandidate(candidateId);
      if (!video || !video.isConnected) {
        void chrome.runtime
          .sendMessage({ t: 'session/error', sessionId, code: 'no-video' })
          .catch(() => {});
        throw new Error(`candidate ${candidateId} no longer exists`);
      }
      const session = new PipSession(sessionId, video, tier, () => {
        if (current === session) current = null;
      });
      current = session;
      log.debug('starting session', { sessionId, tier });
      await session.start();
    },

    async stop(reason) {
      const session = current;
      current = null;
      await session?.stop(reason ?? 'user');
    },

    state: () => current?.state ?? 'idle',

    startRelay(sessionId) {
      if (current) return; // this frame owns the session — nothing to relay
      if (relay) return;
      // Prefer scoping to the embedded player (largest iframe) so we ignore
      // unrelated page text. A frame with no such iframe is itself likely the
      // caption-overlay layer sitting over a sibling video frame — scan it whole.
      let refEl: Element | null = null;
      let bestArea = RELAY_MIN_PLAYER_AREA;
      const iframes = Array.from(document.querySelectorAll('iframe'));
      for (const f of iframes) {
        const r = f.getBoundingClientRect();
        const area = r.width * r.height;
        if (area > bestArea) {
          bestArea = area;
          refEl = f;
        }
      }
      const scoped = refEl !== null;
      const ref = refEl ?? document.documentElement;
      diag('relay/start', { sessionId, iframes: iframes.length, scoped });
      // DomOverlaySource is built around a video element, but only uses it for
      // geometry/ownerDocument/connectivity — an iframe stands in fine here.
      relay = new DomOverlaySource(ref as unknown as HTMLVideoElement, () =>
        ref.getBoundingClientRect(),
      );
      relay.start((cue) => {
        void chrome.runtime
          .sendMessage({ t: 'subs/cue', sessionId, cue })
          .catch(() => {});
      });
    },

    stopRelay() {
      relay?.stop();
      relay = null;
    },

    injectCue(cue: SubtitleCue | null) {
      current?.feedRelayCue(cue);
    },
  };

  globalThis.__pipEngine = api;
}
