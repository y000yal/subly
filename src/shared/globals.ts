// Contracts between the three things that share a frame's ISOLATED world:
// the declared content stub, the lazily-imported engine chunk, and functions
// injected via chrome.scripting.executeScript (which run in the same world).

import type { FrameScanResult, PipTier, SessionState } from './messages';

export interface PipEngineGlobal {
  /** Synchronous, bounded scan of this frame (and accessible same-origin child frames). */
  scan(): FrameScanResult;
  start(sessionId: string, candidateId: string, tier: PipTier): Promise<void>;
  stop(reason?: string): Promise<void>;
  state(): SessionState;
}

export interface PipStubGlobal {
  ensureEngine(): Promise<PipEngineGlobal>;
  scanForActivation(): Promise<FrameScanResult>;
}

declare global {
  // eslint-disable-next-line no-var
  var __pipEngine: PipEngineGlobal | undefined;
  // eslint-disable-next-line no-var
  var __pipStub: PipStubGlobal | undefined;
}

export {};
