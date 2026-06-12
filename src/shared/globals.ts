// Contract for the engine API that the injected engine.js chunk registers on
// globalThis in each frame's ISOLATED world. Both the scan call and the later
// start/stop calls (all dispatched via chrome.scripting.executeScript) read it
// from the same world, so the per-frame video registry stays consistent.

import type { FrameScanResult, PipTier, SessionState } from './messages';

export interface PipEngineGlobal {
  /** Synchronous, bounded scan of this frame (and accessible same-origin child frames). */
  scan(): FrameScanResult;
  start(sessionId: string, candidateId: string, tier: PipTier): Promise<void>;
  stop(reason?: string): Promise<void>;
  state(): SessionState;
}

declare global {
  // eslint-disable-next-line no-var
  var __pipEngine: PipEngineGlobal | undefined;
}

export {};
