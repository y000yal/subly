// One PiP session: owns the subtitle engine, the tier handle, settings
// watching, and reporting to the background. Everything it allocates is
// released through a single idempotent end path.

import type { ErrorCode, PipMode, PipTier, SessionState } from '@/shared/messages';
import { loadSettings, watchSettings } from '@/shared/settings';
import { createLogger } from '@/shared/logger';
import { diag } from '@/shared/diag';
import { SubtitleEngine } from './subtitles/arbiter';
import type { SubtitleCue } from './subtitles/types';
import { openDocPip, PipError, type DocPipHandle } from './pip/doc-pip';
import { startCanvasPip, type CanvasPipHandle } from './pip/canvas-pip';
import { resolveCandidate, scanFrame } from './detect/video-detector';

const log = createLogger('session');
const RETRY_TOAST_MS = 15_000;
// While our own in-frame sources are producing cues, ignore relayed ones so we
// never override local subtitles with a cross-frame guess.
const RELAY_GRACE_MS = 5_000;

export class PipSession {
  state: SessionState = 'idle';

  private subs = new SubtitleEngine();
  private docHandle: DocPipHandle | null = null;
  private canvasHandle: CanvasPipHandle | null = null;
  private unwatchSettings: (() => void) | null = null;
  private ended = false;
  private subsAttached = false;
  private replaceTimer: ReturnType<typeof setInterval> | undefined;
  private lastLocalCueAt = 0;

  constructor(
    private readonly sessionId: string,
    private video: HTMLVideoElement,
    private readonly tier: PipTier,
    private readonly onEnded: () => void,
  ) {}

  async start(): Promise<void> {
    this.report('starting');
    diag('session/start', { sessionId: this.sessionId, tier: this.tier });
    const settings = await loadSettings();

    // Attach subtitle capture BEFORE any element move so player-container
    // discovery still sees the in-page geometry.
    let refRect: () => DOMRect = () => this.video.getBoundingClientRect();
    if (!this.subsAttached) {
      this.subs.attach(this.video, () => refRect());
      this.subsAttached = true;
    }

    if (this.tier === 'docpip') {
      try {
        const handle = await openDocPip(this.video, settings, {
          onClosed: () => this.end(),
          onHostile: () => true, // attempt the mirror swap before giving up
        });
        this.docHandle = handle;
        refRect = () => handle.refRect();
        this.subs.onCue((cue) => {
          if (cue?.text) this.lastLocalCueAt = Date.now();
          diag('cue/render', { len: cue?.text.length ?? 0 });
          handle.ui.renderCue(cue);
        });
        this.unwatchSettings = watchSettings((s) => handle.ui.applySettings(s));
        diag('session/active', { mode: handle.mode });
        this.report('active-docpip', handle.mode);
      } catch (err) {
        if (err instanceof PipError && err.code === 'gesture-expired') {
          // The activation that reached this frame expired before
          // requestWindow ran. A click on our in-page toast is a fresh one.
          log.warn('transient activation expired; offering retry toast');
          diag('session/gesture-expired');
          this.showRetryToast();
          return;
        }
        this.fail(err instanceof PipError ? err.code : 'engine-error', String(err));
      }
      return;
    }

    // tier === 'canvas' (cross-origin iframe)
    try {
      const handle = await startCanvasPip(this.video, settings, {
        onClosed: () => this.end(),
      });
      this.canvasHandle = handle;
      this.subs.onCue((cue) => {
        if (cue?.text) this.lastLocalCueAt = Date.now();
        diag('cue/burn', { len: cue?.text.length ?? 0 });
        handle.setCue(cue);
      });
      this.unwatchSettings = watchSettings((s) => handle.applySettings(s));
      diag('session/active', { mode: handle.mode });
      this.report(handle.mode === 'canvas' ? 'active-canvas' : 'active-native', handle.mode);
      if (handle.mode === 'canvas') this.watchVideoReplacement();
    } catch (err) {
      const detail = String(err);
      if (detail.includes('NotAllowedError')) {
        // Transient activation expired (e.g. we waited out a buffering video).
        // A click on the toast is a fresh gesture for this frame.
        log.warn('canvas tier lost activation; offering retry toast');
        diag('session/gesture-expired');
        this.showRetryToast();
        return;
      }
      this.fail('pip-denied', detail);
    }
  }

  async stop(_reason: string): Promise<void> {
    if (this.docHandle) {
      this.docHandle.close('user'); // its close path calls end()
      return;
    }
    if (this.canvasHandle) {
      await this.canvasHandle.stop();
      this.end();
      return;
    }
    this.end();
  }

  /**
   * Players rebuild their DOM (quality switch, real playback start) and
   * replace the <video> element. Follow it: same canvas + PiP window (no new
   * gesture), new draw source, subtitle engine re-attached to the new element.
   */
  private watchVideoReplacement(): void {
    clearInterval(this.replaceTimer);
    this.replaceTimer = setInterval(() => {
      if (this.ended || this.video.isConnected) return;
      const scan = scanFrame();
      const best = [...scan.candidates].sort((a, b) => b.score - a.score)[0];
      const next = best ? resolveCandidate(best.candidateId) : null;
      if (!next || next === this.video || !next.isConnected) return;
      diag('session/video-replaced', { candidate: best?.candidateId });
      this.video = next;
      this.canvasHandle?.setSource(next);
      this.subs.detach();
      this.subs = new SubtitleEngine();
      this.subs.attach(next, () => next.getBoundingClientRect());
      this.subs.onCue((cue) => {
        if (cue?.text) this.lastLocalCueAt = Date.now();
        diag('cue/burn', { len: cue?.text.length ?? 0 });
        this.canvasHandle?.setCue(cue);
      });
    }, 1500);
  }

  /**
   * A cue scraped by another frame (cross-frame relay) for players that render
   * captions outside the video's frame. Only used while our own in-frame sources
   * are silent, so it never overrides locally-detected subtitles.
   */
  feedRelayCue(cue: SubtitleCue | null): void {
    if (this.ended) return;
    if (Date.now() - this.lastLocalCueAt < RELAY_GRACE_MS) return;
    diag('cue/relay', { len: cue?.text?.length ?? 0 });
    this.canvasHandle?.setCue(cue);
    this.docHandle?.ui.renderCue(cue);
  }

  private end(): void {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.replaceTimer);
    this.unwatchSettings?.();
    this.unwatchSettings = null;
    if (this.subsAttached) this.subs.detach();
    this.docHandle = null;
    this.canvasHandle = null;
    this.report('idle');
    this.onEnded();
  }

  private fail(code: ErrorCode, detail?: string): void {
    log.error('session failed', code, detail);
    void chrome.runtime
      .sendMessage({ t: 'session/error', sessionId: this.sessionId, code, detail })
      .catch(() => {});
    this.state = 'failed';
    this.end();
  }

  private report(state: SessionState, mode?: PipMode): void {
    this.state = state;
    void chrome.runtime
      .sendMessage({ t: 'session/state', sessionId: this.sessionId, state, mode })
      .catch(() => {});
  }

  private showRetryToast(): void {
    const id = '__captiv_retry';
    document.getElementById(id)?.remove();
    const el = document.createElement('div');
    el.id = id;
    el.setAttribute('data-captiv', 'toast');
    el.textContent = 'Click to open Picture-in-Picture';
    el.style.cssText =
      'position:fixed;z-index:2147483647;right:16px;bottom:16px;cursor:pointer;' +
      'background:#1d4ed8;color:#fff;font:600 13px/1.4 system-ui,sans-serif;' +
      'padding:12px 16px;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.45);';
    const timeout = setTimeout(() => {
      el.remove();
      this.fail('gesture-expired', 'retry toast ignored');
    }, RETRY_TOAST_MS);
    el.addEventListener('click', () => {
      clearTimeout(timeout);
      el.remove();
      void this.start(); // click = fresh transient activation
    });
    document.documentElement.appendChild(el);
  }
}
