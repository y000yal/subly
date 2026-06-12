// Engine bootstrap. The stub (or an injected scan function) dynamic-imports
// this chunk; it registers a single per-frame API on globalThis and keeps at
// most one live session per frame.

import type { PipEngineGlobal } from '@/shared/globals';
import { resolveCandidate, scanFrame } from './detect/video-detector';
import { PipSession } from './session';
import { createLogger } from '@/shared/logger';

const log = createLogger('engine');

export function registerEngine(): void {
  if (globalThis.__pipEngine) return;

  let current: PipSession | null = null;

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
  };

  globalThis.__pipEngine = api;
}
