// Tier 1: Document Picture-in-Picture with the real <video> element moved into
// the PiP window. Same browsing context, so DRM/EME playback continues. The
// riskiest logic in the product lives here: placeholder, re-grab guard against
// site scripts, and idempotent restore.

import type { SubtitleSettings } from '@/shared/settings';
import { createLogger } from '@/shared/logger';
import { diag } from '@/shared/diag';
import { createPipUI, type PipUI } from './pip-ui';
import { captureStreamOf, getDocPip } from './compat';

const log = createLogger('docpip');

const REGRAB_LIMIT = 3;
const REGRAB_WINDOW_MS = 10_000;
const WATCH_MS = 500;

export type DocPipCloseReason = 'user' | 'navigation' | 'fullscreen' | 'hostile' | 'error';

export interface DocPipHooks {
  onClosed(reason: DocPipCloseReason): void;
  /** Site keeps stealing the element back. Return true to swap to mirror mode. */
  onHostile(): boolean;
}

export interface DocPipHandle {
  pipWindow: Window;
  ui: PipUI;
  mode: 'docpip-move' | 'docpip-mirror';
  /** Rect of the video's footprint left behind in the page (for overlay geometry). */
  refRect(): DOMRect;
  close(reason?: DocPipCloseReason): void;
}

export async function openDocPip(
  video: HTMLVideoElement,
  settings: SubtitleSettings,
  hooks: DocPipHooks,
): Promise<DocPipHandle> {
  const docPip = getDocPip();
  if (!docPip) throw new PipError('pip-denied', 'Document PiP API unavailable');

  const rect = video.getBoundingClientRect();
  const ratio =
    video.videoWidth > 0 ? video.videoWidth / video.videoHeight : rect.width / Math.max(1, rect.height) || 16 / 9;
  const width = Math.round(Math.min(Math.max(rect.width || 640, 360), 1024));
  const height = Math.round(width / (ratio || 16 / 9));

  // FIRST thing: consume the transient activation before any other async work.
  let pipWindow: Window;
  try {
    pipWindow = await docPip.requestWindow({ width, height });
    diag('docpip/window-open', { width, height });
  } catch (err) {
    diag('docpip/window-failed', { err: String(err) });
    if (err instanceof DOMException && err.name === 'NotAllowedError') {
      throw new PipError('gesture-expired', err.message);
    }
    throw new PipError('pip-denied', String(err));
  }

  // ---- snapshot original placement ----
  const parent = video.parentNode;
  const nextSibling = video.nextSibling;
  const originalCssText = video.style.cssText;
  const hadControls = video.controls;
  const wasPlaying = !video.paused && !video.ended;
  const shownTracks: TextTrack[] = [];
  for (const track of Array.from(video.textTracks)) {
    // Avoid double captions: the browser would natively paint 'showing' cues on
    // the moved element. Hidden tracks still fire cuechange for our overlay.
    if (track.mode === 'showing') {
      shownTracks.push(track);
      track.mode = 'hidden';
    }
  }

  // ---- placeholder keeps the page layout and marks the way home ----
  const pageDoc = video.ownerDocument;
  const placeholder = pageDoc.createElement('div');
  placeholder.setAttribute('data-pip-subs', 'placeholder');
  placeholder.style.cssText =
    `width:${Math.max(1, rect.width)}px;height:${Math.max(1, rect.height)}px;` +
    'background:#000;color:#9ca3af;display:flex;align-items:center;justify-content:center;' +
    'font:13px system-ui,sans-serif;cursor:pointer;text-align:center;';
  placeholder.textContent = 'Playing in Picture-in-Picture — click to return';
  placeholder.addEventListener('click', () => close('user'));
  parent?.insertBefore(placeholder, video);

  // ---- build PiP window and move the element ----
  const ui = createPipUI(pipWindow, settings, { onRequestClose: () => close('user') });
  ui.stage.appendChild(video); // cross-document move; playback continues
  video.controls = false;
  ui.bindVideo(video);
  if (wasPlaying && video.paused) void video.play().catch(() => {});

  // ---- guards ----
  let mode: 'docpip-move' | 'docpip-mirror' = 'docpip-move';
  let mirror: { el: HTMLVideoElement; stream: MediaStream } | null = null;
  let regrabs: number[] = [];
  let closed = false;

  const watchTimer = setInterval(() => {
    if (closed) return;
    // Page navigated section away (SPA) — our way home is gone.
    if (!placeholder.isConnected) {
      close('navigation');
      return;
    }
    // Site script yanked the video back into the page.
    if (mode === 'docpip-move' && video.ownerDocument !== pipWindow.document) {
      const now = Date.now();
      regrabs = regrabs.filter((t) => now - t < REGRAB_WINDOW_MS);
      regrabs.push(now);
      if (regrabs.length >= REGRAB_LIMIT) {
        log.warn('site keeps re-grabbing the video');
        diag('docpip/hostile', { regrabs: regrabs.length });
        if (hooks.onHostile() && tryMirror()) return;
        close('hostile');
      } else {
        ui.stage.appendChild(video);
      }
    }
  }, WATCH_MS);

  const onFullscreen = () => {
    if (pageDoc.fullscreenElement) close('fullscreen');
  };
  pageDoc.addEventListener('fullscreenchange', onFullscreen);

  const onPageHide = () => close('navigation');
  window.addEventListener('pagehide', onPageHide);

  pipWindow.addEventListener('pagehide', () => {
    // Fires for both user-close and programmatic close; closeReason is set
    // beforehand by close() and defaults to 'user' for the window's X button.
    finish(closeReason);
  });

  /**
   * Hostile-site fallback: put the real element back where the site wants it
   * and show a captureStream mirror in the PiP window instead. Not possible
   * for DRM media (captureStream is blocked).
   */
  function tryMirror(): boolean {
    if (video.mediaKeys != null) return false;
    let stream: MediaStream;
    try {
      stream = captureStreamOf(video);
    } catch {
      return false;
    }
    restoreVideo();
    const el = pipWindow.document.createElement('video');
    el.muted = true; // audio keeps playing from the page element
    el.autoplay = true;
    el.playsInline = true;
    el.srcObject = stream;
    ui.stage.appendChild(el);
    void el.play().catch(() => {});
    ui.bindVideo(video); // controls still drive the real element
    mirror = { el, stream };
    mode = 'docpip-mirror';
    log.warn('switched to mirror mode');
    diag('docpip/mirror-mode');
    return true;
  }

  function restoreVideo(): void {
    if (video.ownerDocument === pipWindow.document) {
      try {
        if (placeholder.isConnected) {
          placeholder.replaceWith(video);
        } else if (parent && (parent as ParentNode & { isConnected: boolean }).isConnected) {
          if (nextSibling && nextSibling.parentNode === parent) parent.insertBefore(video, nextSibling);
          else parent.appendChild(video);
        }
      } catch (err) {
        log.warn('restore placement failed', err);
      }
    }
    placeholder.remove();
    video.style.cssText = originalCssText;
    video.controls = hadControls;
    for (const track of shownTracks) {
      try {
        track.mode = 'showing';
      } catch {
        // track may be gone after src change
      }
    }
    if (wasPlaying && video.paused && video.isConnected) void video.play().catch(() => {});
  }

  function finish(reason: DocPipCloseReason): void {
    if (closed) return;
    closed = true;
    clearInterval(watchTimer);
    pageDoc.removeEventListener('fullscreenchange', onFullscreen);
    window.removeEventListener('pagehide', onPageHide);
    mirror?.stream.getTracks().forEach((t) => t.stop());
    mirror = null;
    ui.destroy();
    if (mode === 'docpip-move') restoreVideo();
    else placeholder.remove();
    hooks.onClosed(reason);
  }

  let closeReason: DocPipCloseReason = 'user';
  function close(reason: DocPipCloseReason): void {
    closeReason = reason;
    if (closed) return;
    try {
      pipWindow.close(); // triggers pipWindow pagehide -> finish
    } catch {
      finish(reason);
    }
    // pagehide is synchronous-ish but guard against it not firing
    setTimeout(() => finish(closeReason), 250);
  }

  return {
    pipWindow,
    ui,
    get mode() {
      return mode;
    },
    refRect: () => {
      // In mirror mode the placeholder is gone (video restored to the page):
      // a disconnected placeholder reports a zero rect, which would blind the
      // DOM-overlay geometry checks. Fall back to the live video rect.
      if (placeholder.isConnected) return placeholder.getBoundingClientRect();
      return video.getBoundingClientRect();
    },
    close,
  };
}

export class PipError extends Error {
  constructor(
    public readonly code: 'gesture-expired' | 'pip-denied',
    message: string,
  ) {
    super(message);
  }
}
