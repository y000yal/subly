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
  /** Cross-frame subtitle relay: scrape captions in THIS (non-video) frame and
   *  report them to the background for forwarding to the session frame. No-op in
   *  the frame that owns the active session. */
  startRelay(sessionId: string): void;
  stopRelay(): void;
  /** Feed a caption cue scraped by another frame into the active session. */
  injectCue(cue: { text: string; html?: string } | null): void;
}

declare global {
  // eslint-disable-next-line no-var
  var __pipEngine: PipEngineGlobal | undefined;
}

export {};
