// Tier 2: runs INSIDE a cross-origin iframe, where Document PiP cannot be
// requested. Video frames + subtitle text are composited onto a canvas, the
// canvas stream feeds a hidden video, and that goes into native PiP (subtitles
// burned in). Tier 3 degradation: DRM media blacks out canvases, so fall back
// to plain native PiP and say so honestly.

import type { SubtitleCue } from '../subtitles/types';
import { coerceText } from '../subtitles/sanitize';
import type { SubtitleSettings } from '@/shared/settings';
import { bgRgba } from '@/shared/settings';
import { createLogger } from '@/shared/logger';
import { diag } from '@/shared/diag';
import { captureStreamOf, startFramePump } from './compat';

const log = createLogger('canvas');

const MAX_CANVAS_WIDTH = 1920;
const SLOW_REDRAW_MS = 250; // paused video + cue updates between timeupdate ticks
const CAPTURE_FPS = 30;
const WAIT_FOR_DATA_MS = 8000;
const PIPELINE_STEP_TIMEOUT_MS = 4000;

export interface CanvasPipHooks {
  onClosed(reason: 'user' | 'error'): void;
}

export interface CanvasPipHandle {
  mode: 'canvas' | 'native-only';
  applySettings(s: SubtitleSettings): void;
  setCue(cue: SubtitleCue | null): void;
  /** Follow a player element swap (canvas mode only; no-op for native). */
  setSource(next: HTMLVideoElement): void;
  stop(): Promise<void>;
}

export async function startCanvasPip(
  video: HTMLVideoElement,
  initialSettings: SubtitleSettings,
  hooks: CanvasPipHooks,
): Promise<CanvasPipHandle> {
  diag('canvas/start', {
    mediaKeys: video.mediaKeys != null,
    videoSize: `${video.videoWidth}x${video.videoHeight}`,
    readyState: video.readyState,
    sameDoc: video.ownerDocument === document,
  });
  if (video.mediaKeys != null) {
    return startNativeOnly(video, hooks, 'protected (DRM) video');
  }

  // A buffering/stalled stream has no decoded frames (videoWidth 0): the
  // canvas would never produce real content and the pipeline below would hang
  // at play(). Wait briefly for data, then bail with an honest error.
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.videoWidth === 0) {
    diag('canvas/waiting-for-data', { readyState: video.readyState });
    const gotData = await waitForVideoData(video, WAIT_FOR_DATA_MS);
    diag('canvas/wait-result', { gotData, readyState: video.readyState });
    if (!gotData) {
      showInlineToast(
        'Subly: the video is still loading — try again once it plays.',
      );
      throw new Error('video has no frames (stalled or still buffering)');
    }
  }

  const canvas = document.createElement('canvas');
  const scale = Math.min(1, MAX_CANVAS_WIDTH / Math.max(1, video.videoWidth || 1280));
  canvas.width = Math.max(2, Math.round((video.videoWidth || 1280) * scale));
  canvas.height = Math.max(2, Math.round((video.videoHeight || 720) * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return startNativeOnly(video, hooks, 'canvas unavailable');

  // Prime the canvas so captureStream always has a first frame to emit, even
  // before the first successful drawImage.
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Probe: EME/tainted sources throw or paint black on readback.
  try {
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    ctx.getImageData(0, 0, 1, 1);
  } catch (err) {
    log.warn('canvas readback blocked, degrading to native PiP', err);
    diag('canvas/readback-blocked', { err: String(err) });
    return startNativeOnly(video, hooks, 'protected video');
  }

  let settings = initialSettings;
  let cue: SubtitleCue | null = null;
  let requestFrame: (() => void) | null = null;
  let src = video; // mutable: setSource() follows player element swaps

  const draw = () => {
    try {
      ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
    } catch {
      return; // transient decode states
    }
    const text = cue?.text ? coerceText(cue.text) : '';
    if (text) drawCue(ctx, canvas, text, settings);
    // Chromium throttles compositing of non-interacted cross-origin iframes —
    // exactly where this code runs. captureStream only emits frames on
    // compositor commits, so without this the PiP image freezes until the
    // user hovers the player. requestFrame() captures unconditionally.
    requestFrame?.();
  };
  draw();

  let stopPump = startFramePump(video, draw);
  const slowTimer = setInterval(draw, SLOW_REDRAW_MS);

  const stream = captureStreamOf(canvas, CAPTURE_FPS);
  const track = stream.getVideoTracks()[0] as
    | (MediaStreamTrack & { requestFrame?: () => void })
    | undefined;
  if (track && typeof track.requestFrame === 'function') {
    requestFrame = () => track.requestFrame!();
  }
  const hidden = document.createElement('video');
  hidden.muted = true; // audio keeps playing from the real element
  hidden.playsInline = true;
  hidden.srcObject = stream;
  hidden.style.cssText = 'position:fixed;left:-99999px;top:0;width:2px;height:2px;';
  hidden.setAttribute('data-pip-subs', 'mirror');
  document.documentElement.appendChild(hidden);

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    clearInterval(slowTimer);
    stopPump();
    try {
      if (document.pictureInPictureElement === hidden) await document.exitPictureInPicture();
    } catch {
      // already closed
    }
    stream.getTracks().forEach((t) => t.stop());
    hidden.remove();
    clearMediaSession();
  };

  try {
    // play() on a stream-backed video pends until the first frame arrives —
    // never let it hang the whole session.
    await withTimeout(hidden.play(), PIPELINE_STEP_TIMEOUT_MS, 'hidden video play()');
    await withTimeout(
      hidden.requestPictureInPicture(),
      PIPELINE_STEP_TIMEOUT_MS,
      'requestPictureInPicture()',
    );
    diag('canvas/pip-open');
  } catch (err) {
    await stop();
    log.warn('canvas PiP failed, degrading to native PiP', err);
    diag('canvas/pip-failed', { err: String(err) });
    return startNativeOnly(video, hooks, 'this player');
  }

  hidden.addEventListener('leavepictureinpicture', () => {
    void stop();
    hooks.onClosed('user');
  });
  // Native PiP window play/pause buttons come from Media Session.
  bindMediaSession(src);

  return {
    mode: 'canvas',
    applySettings: (s) => {
      settings = s;
    },
    setCue: (c) => {
      cue = c;
      // Redraw immediately — do not wait for the next video frame / hover.
      draw();
    },
    // Follow a player element swap WITHOUT a new PiP request (no gesture
    // needed): same canvas, same stream, same PiP window — new source.
    setSource: (next: HTMLVideoElement) => {
      diag('canvas/source-swapped', { size: `${next.videoWidth}x${next.videoHeight}` });
      stopPump();
      src = next;
      stopPump = startFramePump(next, draw);
      bindMediaSession(next);
    },
    stop,
  };
}

// ---- tier 3 ----------------------------------------------------------------

async function startNativeOnly(
  video: HTMLVideoElement,
  hooks: CanvasPipHooks,
  why: string,
): Promise<CanvasPipHandle> {
  diag('native-only/start', { why });
  try {
    await video.requestPictureInPicture();
  } catch (err) {
    diag('native-only/rejected', { err: String(err) });
    throw new Error(`native PiP rejected: ${String(err)}`);
  }
  showInlineToast(
    `Subtitles can't be shown for ${why} — opened standard Picture-in-Picture instead.`,
  );
  const onLeave = () => hooks.onClosed('user');
  video.addEventListener('leavepictureinpicture', onLeave, { once: true });
  return {
    mode: 'native-only',
    applySettings: () => {},
    setCue: () => {},
    setSource: () => {},
    stop: async () => {
      video.removeEventListener('leavepictureinpicture', onLeave);
      try {
        if (document.pictureInPictureElement === video) await document.exitPictureInPicture();
      } catch {
        // already closed
      }
    },
  };
}

// ---- helpers ----------------------------------------------------------------

/** Resolve true once the video has decodable frames, false on timeout. */
function waitForVideoData(video: HTMLVideoElement, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const check = () =>
      video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0;
    if (check()) {
      resolve(true);
      return;
    }
    const events = ['loadeddata', 'canplay', 'playing', 'timeupdate'] as const;
    let timer: ReturnType<typeof setTimeout>;
    const done = (ok: boolean) => {
      clearTimeout(timer);
      for (const ev of events) video.removeEventListener(ev, onEvent);
      resolve(ok);
    };
    const onEvent = () => {
      if (check()) done(true);
    };
    for (const ev of events) video.addEventListener(ev, onEvent);
    timer = setTimeout(() => done(check()), timeoutMs);
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

function drawCue(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  text: string,
  s: SubtitleSettings,
): void {
  const fontPx = Math.max(10, Math.round((canvas.height * s.fontSizePct) / 100));
  const family =
    s.fontFamily === 'sans-serif' ? 'system-ui, sans-serif' : s.fontFamily;
  ctx.font = `600 ${fontPx}px ${family}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';

  const maxWidth = canvas.width * 0.9;
  const lines = text
    .split('\n')
    .flatMap((line) => wrapLine(ctx, line, maxWidth));
  const lineHeight = Math.round(fontPx * 1.35);
  const padX = Math.round(fontPx * 0.45);
  const padY = Math.round(fontPx * 0.18);
  const blockHeight = lines.length * lineHeight;
  const margin = Math.round(canvas.height * 0.06);
  const baseY =
    s.position === 'bottom' ? canvas.height - margin - blockHeight : margin + lineHeight;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const y = baseY + i * lineHeight + fontPx * 0.8;
    const w = ctx.measureText(line).width;
    ctx.fillStyle = bgRgba(s);
    ctx.fillRect(
      canvas.width / 2 - w / 2 - padX,
      y - fontPx - padY,
      w + padX * 2,
      lineHeight + padY,
    );
    ctx.fillStyle = s.textColor;
    if (s.edgeStyle === 'shadow') {
      ctx.shadowColor = 'rgba(0,0,0,.9)';
      ctx.shadowBlur = 4;
    }
    ctx.fillText(line, canvas.width / 2, y);
    ctx.shadowBlur = 0;
  }
}

function wrapLine(ctx: CanvasRenderingContext2D, line: string, maxWidth: number): string[] {
  if (ctx.measureText(line).width <= maxWidth) return [line];
  const words = line.split(' ');
  const out: string[] = [];
  let cur = '';
  for (const word of words) {
    const candidate = cur ? `${cur} ${word}` : word;
    if (ctx.measureText(candidate).width > maxWidth && cur) {
      out.push(cur);
      cur = word;
    } else {
      cur = candidate;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function bindMediaSession(video: HTMLVideoElement): void {
  try {
    navigator.mediaSession.setActionHandler('play', () => void video.play().catch(() => {}));
    navigator.mediaSession.setActionHandler('pause', () => video.pause());
  } catch {
    // media session unsupported in this context
  }
}

function clearMediaSession(): void {
  try {
    navigator.mediaSession.setActionHandler('play', null);
    navigator.mediaSession.setActionHandler('pause', null);
  } catch {
    // ignore
  }
}

function showInlineToast(text: string): void {
  const id = '__subly_toast';
  document.getElementById(id)?.remove();
  const el = document.createElement('div');
  el.id = id;
  el.setAttribute('data-subly', 'toast');
  el.textContent = text;
  el.style.cssText =
    'position:fixed;z-index:2147483647;right:12px;bottom:12px;max-width:320px;' +
    'background:#111827;color:#f9fafb;font:12px/1.4 system-ui,sans-serif;' +
    'padding:8px 12px;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.4);';
  document.documentElement.appendChild(el);
  setTimeout(() => el.remove(), 5000);
}
