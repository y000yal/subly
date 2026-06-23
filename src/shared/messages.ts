// Typed message protocol. All cross-context traffic (background <-> frames)
// uses these discriminated unions so every handler can switch exhaustively.

export type PipTier = 'docpip' | 'canvas';

export type PipMode = 'docpip-move' | 'docpip-mirror' | 'canvas' | 'native-only';

export type SessionState =
  | 'idle'
  | 'detecting'
  | 'starting'
  | 'active-docpip'
  | 'active-canvas'
  | 'active-native'
  | 'restoring'
  | 'failed';

export type ErrorCode =
  | 'no-video'
  | 'gesture-expired'
  | 'pip-denied'
  | 'drm-canvas'
  | 'hostile-page'
  | 'engine-error';

/** Serializable candidate report a frame returns from a scan. */
export interface VideoCandidateInfo {
  candidateId: string;
  score: number;
  rect: { x: number; y: number; width: number; height: number };
  playing: boolean;
  hasTextTracks: boolean;
  drmSuspected: boolean;
}

/** Result of the injected scan function, one per frame. */
export interface FrameScanResult {
  candidates: VideoCandidateInfo[];
  isTop: boolean;
  /** True when a same-origin parent frame's scan already covers this frame. */
  coveredByParent: boolean;
}

import type { DiagEvent } from './diag';

// background -> content. Session start/stop intentionally do NOT use
// messaging: sandboxed/opaque-origin player frames never receive declared
// content scripts (no listener), so the background drives the winning frame
// via chrome.scripting.executeScript instead.
export type BgToContentMessage =
  // diagnostics trail forwarded to the top frame for DOM mirroring
  { t: 'diag/trail'; events: DiagEvent[] };

// content -> background
export type ContentToBgMessage =
  | { t: 'session/state'; sessionId: string; state: SessionState; mode?: PipMode }
  | { t: 'session/error'; sessionId: string; code: ErrorCode; detail?: string }
  | { t: 'diag/event'; event: DiagEvent }
  // a non-video frame relayed a caption cue it scraped (cross-frame subtitle
  // relay); background forwards it to the session frame.
  | { t: 'subs/cue'; sessionId: string; cue: { text: string; html?: string } | null }
  // debug/e2e hook: run the full toggle flow as if the toolbar was clicked
  | { t: 'test/toggle' };

export type AnyMessage = BgToContentMessage | ContentToBgMessage;

export function isExtensionMessage(msg: unknown): msg is AnyMessage {
  return typeof msg === 'object' && msg !== null && typeof (msg as { t?: unknown }).t === 'string';
}
